// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD — Sherwood Pact (proof-of-hold, Robinhood Chain) — v2
 *
 *  The "don't connect your wallet to earn" path. It is NOT custody staking — tokens never
 *  move; the holder just keeps holding. A contract cannot read historical balances, so
 *  continuous holding is verified OFF-CHAIN by the bubble-map indexer (transfer history),
 *  then an owner-appointed ORACLE submits the result on-chain. Trust/oracle model by design.
 *
 *  Flow:
 *   1. createPact(minHold, duration) payable  — holder pays the entry fee (≈ $11 in RH-ETH).
 *      The FULL entry is escrowed (reservedEntries) and can't be swept by the owner.
 *   2. off-chain: indexer checks the wallet held ≥ minHold $STAG for the whole window.
 *   3. oracle.verify(id, held, reward):
 *        held  → payout = refund (≈ $5) + reward; the rest of the entry is released as backend costs.
 *        !held → forfeit the entry (released to the treasury as backend costs).
 *   4. holder.claim(id) — pulls the payout.
 *
 *  Holder protection: if the oracle never resolves a pact, the holder can reclaim() the full
 *  entry after the window + grace period — a censoring/lost oracle can't strand funds. Reward
 *  is capped by maxReward, bounding a compromised oracle's drain.
 *
 *  Solvency invariant: balance ≥ reservedPayouts + reservedEntries at all times, so verified
 *  payouts and holder reclaims are always fully funded and the owner can only ever withdraw the
 *  genuine free treasury (resolved backend costs + reward top-ups).
 *
 *  ⚠️ Holds real funds — get a security review before mainnet.
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SherwoodPact is Ownable, ReentrancyGuard {
    address public immutable stag;    // token whose holding is attested (verified off-chain)
    address public oracle;            // submits indexer-verified results

    uint256 public entryFee;          // ETH to open a pact (≈ $11 equiv, owner-set)
    uint256 public refundAmount;      // ETH returned if you held (≈ $5 equiv, owner-set; ≤ entryFee)
    uint256 public maxReward;         // cap on the oracle-supplied reward per pact (bounds oracle drain)
    uint64  public minDuration = 7 days;
    uint64  public maxDuration = 365 days;
    uint64  public grace = 14 days;   // after window+grace an unresolved pact is holder-reclaimable

    uint256 public reservedPayouts;   // ETH owed to verified-but-unclaimed pacts
    uint256 public reservedEntries;   // escrowed entries of still-Open pacts (holder-recoverable)

    enum Status { None, Open, Verified, Claimed, Forfeited, Reclaimed }

    struct Pact {
        address wallet;
        uint256 minHold;
        uint64  start;
        uint64  duration;
        uint256 entryPaid;
        uint256 payout;
        Status  status;
    }
    Pact[] public pacts;
    mapping(address => uint256[]) public pactsOf;

    event PactCreated(uint256 indexed id, address indexed wallet, uint256 minHold, uint64 start, uint64 duration, uint256 entryPaid);
    event PactVerified(uint256 indexed id, bool held, uint256 payout);
    event PactClaimed(uint256 indexed id, address indexed wallet, uint256 payout);
    event PactReclaimed(uint256 indexed id, address indexed wallet, uint256 amount);
    event TreasuryFunded(address indexed from, uint256 amount);

    constructor(address _stag, uint256 _entryFee, uint256 _refundAmount) Ownable(msg.sender) {
        require(_refundAmount <= _entryFee, "refund > entry");
        stag = _stag;
        entryFee = _entryFee;
        refundAmount = _refundAmount;
        maxReward = _entryFee * 10;   // sane default cap; owner-tunable
        oracle = msg.sender;
    }

    /* ---------------- holder ---------------- */
    function createPact(uint256 minHold, uint64 duration) external payable nonReentrant returns (uint256 id) {
        require(msg.value >= entryFee, "entry fee too low");
        require(minHold > 0, "minHold=0");
        require(duration >= minDuration && duration <= maxDuration, "bad duration");
        id = pacts.length;
        pacts.push(Pact({
            wallet: msg.sender, minHold: minHold, start: uint64(block.timestamp),
            duration: duration, entryPaid: entryFee, payout: 0, status: Status.Open
        }));
        pactsOf[msg.sender].push(id);
        reservedEntries += entryFee;         // full entry escrowed for the holder
        emit PactCreated(id, msg.sender, minHold, uint64(block.timestamp), duration, entryFee);
        uint256 over = msg.value - entryFee; // refund any overpayment
        if (over > 0) { (bool ok, ) = payable(msg.sender).call{value: over}(""); require(ok, "refund failed"); }
    }

    function claim(uint256 id) external nonReentrant {
        Pact storage p = pacts[id];
        require(p.wallet == msg.sender, "not your pact");
        require(p.status == Status.Verified, "not claimable");
        uint256 amt = p.payout;
        p.status = Status.Claimed;
        p.payout = 0;
        reservedPayouts -= amt;
        if (amt > 0) { (bool ok, ) = payable(msg.sender).call{value: amt}(""); require(ok, "eth send failed"); }
        emit PactClaimed(id, msg.sender, amt);
    }

    // Escape hatch: if the oracle never resolved this pact, reclaim the full entry after window + grace.
    function reclaim(uint256 id) external nonReentrant {
        Pact storage p = pacts[id];
        require(p.wallet == msg.sender, "not your pact");
        require(p.status == Status.Open, "not open");
        require(block.timestamp >= uint256(p.start) + p.duration + grace, "not reclaimable yet");
        uint256 amt = p.entryPaid;
        p.status = Status.Reclaimed;
        reservedEntries -= amt;
        (bool ok, ) = payable(msg.sender).call{value: amt}(""); require(ok, "eth send failed");
        emit PactReclaimed(id, msg.sender, amt);
    }

    /* ---------------- oracle (indexer-verified) ---------------- */
    // held=true  → payout = refundAmount + reward (reward ≤ maxReward). held=false → forfeit.
    // Callable only after the hold window ends. Releases the escrowed entry either way.
    function verify(uint256 id, bool held, uint256 reward) external nonReentrant {
        require(msg.sender == oracle || msg.sender == owner(), "not oracle");
        Pact storage p = pacts[id];
        require(p.status == Status.Open, "not open");
        require(block.timestamp >= uint256(p.start) + p.duration, "window not ended");
        reservedEntries -= p.entryPaid;    // this pact's entry is no longer escrowed for reclaim
        if (held) {
            require(reward <= maxReward, "reward > cap");
            uint256 payout = refundAmount + reward;
            require(address(this).balance >= reservedPayouts + reservedEntries + payout, "treasury underfunded");
            p.payout = payout;
            p.status = Status.Verified;
            reservedPayouts += payout;
            emit PactVerified(id, true, payout);
        } else {
            p.status = Status.Forfeited;   // entry kept as backend costs
            emit PactVerified(id, false, 0);
        }
    }

    /* ---------------- treasury / owner ---------------- */
    receive() external payable { emit TreasuryFunded(msg.sender, msg.value); }
    function fund() external payable { emit TreasuryFunded(msg.sender, msg.value); }

    // free (unreserved) treasury = resolved backend costs + reward top-ups; excludes escrowed entries
    // and verified payouts, which the owner can never touch.
    function freeTreasury() public view returns (uint256) {
        uint256 locked = reservedPayouts + reservedEntries;
        return address(this).balance > locked ? address(this).balance - locked : 0;
    }
    function withdrawTreasury(address to, uint256 amount) external onlyOwner {
        require(amount <= freeTreasury(), "exceeds free treasury");
        (bool ok, ) = payable(to).call{value: amount}(""); require(ok, "eth send failed");
    }

    function setOracle(address o) external onlyOwner { require(o != address(0), "zero"); oracle = o; }
    function setEntryFee(uint256 v) external onlyOwner { require(v >= refundAmount, "entry < refund"); entryFee = v; }
    function setRefundAmount(uint256 v) external onlyOwner { require(v <= entryFee, "refund > entry"); refundAmount = v; }
    function setMaxReward(uint256 v) external onlyOwner { maxReward = v; }
    function setGrace(uint64 v) external onlyOwner { grace = v; }
    function setDurationBounds(uint64 lo, uint64 hi) external onlyOwner { require(lo > 0 && hi >= lo, "bad"); minDuration = lo; maxDuration = hi; }

    /* ---------------- views ---------------- */
    function pactCount() external view returns (uint256) { return pacts.length; }
    function pactsOfCount(address a) external view returns (uint256) { return pactsOf[a].length; }
    function openPactsPastWindow(uint256 fromId, uint256 max) external view returns (uint256[] memory ids) {
        uint256[] memory tmp = new uint256[](max);
        uint256 k;
        for (uint256 i = fromId; i < pacts.length && k < max; i++) {
            Pact storage p = pacts[i];
            if (p.status == Status.Open && block.timestamp >= uint256(p.start) + p.duration) { tmp[k++] = i; }
        }
        ids = new uint256[](k);
        for (uint256 j; j < k; j++) ids[j] = tmp[j];
    }
}
