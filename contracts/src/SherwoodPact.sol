// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD — Sherwood Pact (proof-of-hold, Robinhood Chain)
 *
 *  The "don't connect your wallet to earn" path. It is NOT custody staking — tokens never
 *  move; the holder just keeps holding. A contract cannot read historical balances, so
 *  continuous holding is verified OFF-CHAIN by the bubble-map indexer (transfer history),
 *  then an owner-appointed ORACLE submits the result on-chain. Trust/oracle model by design.
 *
 *  Flow:
 *   1. createPact(minHold, duration) payable  — holder pays the entry fee (≈ $11 in RH-ETH).
 *   2. off-chain: indexer checks the wallet held ≥ minHold $STAG for the whole window.
 *   3. oracle.verify(id, held, reward):
 *        held  → payout = refund (≈ $5) + reward(earned); the rest of the entry stays as backend costs.
 *        !held → forfeit the entry (kept by the treasury).
 *   4. holder.claim(id) — pulls the payout.
 *
 *  Separate treasury (this contract's balance). Owner funds rewards + sweeps backend costs, but can
 *  never withdraw ETH already reserved for verified-but-unclaimed payouts.
 *
 *  ⚠️ Holds real funds — get a security review before mainnet.
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SherwoodPact is Ownable, ReentrancyGuard {
    address public immutable stag;    // token whose holding is attested (informational; verified off-chain)
    address public oracle;            // submits indexer-verified results

    uint256 public entryFee;          // ETH to open a pact (≈ $11 equiv, owner-set)
    uint256 public refundAmount;      // ETH returned if you held (≈ $5 equiv, owner-set)
    uint64  public minDuration = 7 days;
    uint64  public maxDuration = 365 days;
    uint256 public reservedPayouts;   // ETH owed to verified-but-unclaimed pacts

    enum Status { None, Open, Verified, Claimed, Forfeited }

    struct Pact {
        address wallet;
        uint256 minHold;     // $STAG the holder commits to keep
        uint64  start;
        uint64  duration;
        uint256 entryPaid;
        uint256 payout;      // set on verify (refund + reward)
        Status  status;
    }
    Pact[] public pacts;
    mapping(address => uint256[]) public pactsOf;

    event PactCreated(uint256 indexed id, address indexed wallet, uint256 minHold, uint64 start, uint64 duration, uint256 entryPaid);
    event PactVerified(uint256 indexed id, bool held, uint256 payout);
    event PactClaimed(uint256 indexed id, address indexed wallet, uint256 payout);
    event TreasuryFunded(address indexed from, uint256 amount);

    constructor(address _stag, uint256 _entryFee, uint256 _refundAmount) Ownable(msg.sender) {
        stag = _stag;
        entryFee = _entryFee;
        refundAmount = _refundAmount;
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
            duration: duration, entryPaid: msg.value, payout: 0, status: Status.Open
        }));
        pactsOf[msg.sender].push(id);
        emit PactCreated(id, msg.sender, minHold, uint64(block.timestamp), duration, msg.value);
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

    /* ---------------- oracle (indexer-verified) ---------------- */
    // held=true  → payout = refundAmount + reward (reward = indexer-computed earned yield).
    // held=false → forfeit (entry stays in the treasury). Callable only after the hold window ends.
    function verify(uint256 id, bool held, uint256 reward) external nonReentrant {
        require(msg.sender == oracle || msg.sender == owner(), "not oracle");
        Pact storage p = pacts[id];
        require(p.status == Status.Open, "not open");
        require(block.timestamp >= p.start + p.duration, "window not ended");
        if (held) {
            uint256 payout = refundAmount + reward;
            require(address(this).balance >= reservedPayouts + payout, "treasury underfunded");
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

    // free (unreserved) treasury = entry fees + top-ups not owed to verified pacts → backend costs
    function freeTreasury() public view returns (uint256) {
        return address(this).balance > reservedPayouts ? address(this).balance - reservedPayouts : 0;
    }
    function withdrawTreasury(address to, uint256 amount) external onlyOwner {
        require(amount <= freeTreasury(), "exceeds free treasury");
        (bool ok, ) = payable(to).call{value: amount}(""); require(ok, "eth send failed");
    }

    function setOracle(address o) external onlyOwner { require(o != address(0), "zero"); oracle = o; }
    function setEntryFee(uint256 v) external onlyOwner { entryFee = v; }
    function setRefundAmount(uint256 v) external onlyOwner { refundAmount = v; }
    function setDurationBounds(uint64 lo, uint64 hi) external onlyOwner { require(lo > 0 && hi >= lo, "bad"); minDuration = lo; maxDuration = hi; }

    /* ---------------- views ---------------- */
    function pactCount() external view returns (uint256) { return pacts.length; }
    function pactsOfCount(address a) external view returns (uint256) { return pactsOf[a].length; }
    function openPactsPastWindow(uint256 fromId, uint256 max) external view returns (uint256[] memory ids) {
        uint256[] memory tmp = new uint256[](max);
        uint256 k;
        for (uint256 i = fromId; i < pacts.length && k < max; i++) {
            Pact storage p = pacts[i];
            if (p.status == Status.Open && block.timestamp >= p.start + p.duration) { tmp[k++] = i; }
        }
        ids = new uint256[](k);
        for (uint256 j; j < k; j++) ids[j] = tmp[j];
    }
}
