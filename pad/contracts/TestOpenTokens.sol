// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// TEST ONLY. An ERC-20 with switches for every kind of bad behaviour the open pad has to face: a fee on transfer
/// (always, or only towards one address), a rebase on every transfer or on demand, blocked addresses, free minting
/// by its owner, a callback fired from inside every transfer (reentrancy), and odd decimals. With every switch off
/// it is a plain token. It can also act as an account (`exec`) so a hostile token can be its own pool's creator.
contract WeirdToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    address public immutable boss;

    uint256 public index = 1e18;                 // balance = raw * index / 1e18 (a rebase moves the index)
    uint256 private rawTotal;
    mapping(address => uint256) private raw;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public feeBps;                       // fee on transfer
    address public feeOnlyTo;                    // zero: fee on every transfer; else only on transfers TO this address
    uint256 public rebaseBpsPerTransfer;         // every transfer grows everyone's balance by this much
    mapping(address => bool) public blocked;     // transfers from or to a blocked address revert
    address public cbTarget;                     // called from inside every transfer
    bytes public cbData;
    bool public cbTried;
    bool public cbOk;
    bytes public cbRet;
    bool private inCb;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d, uint256 supply) {
        name = n;
        symbol = s;
        decimals = d;
        boss = msg.sender;
        raw[msg.sender] = supply;
        rawTotal = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    modifier onlyBoss() {
        require(msg.sender == boss, "boss");
        _;
    }

    function setFee(uint256 bps, address onlyTo) external onlyBoss { feeBps = bps; feeOnlyTo = onlyTo; }
    function setRebasePerTransfer(uint256 bps) external onlyBoss { rebaseBpsPerTransfer = bps; }
    function rebase(uint256 newIndex) external onlyBoss { index = newIndex; }
    function setBlocked(address a, bool b) external onlyBoss { blocked[a] = b; }
    function setCallback(address t, bytes calldata d) external onlyBoss { cbTarget = t; cbData = d; cbTried = false; cbOk = false; cbRet = ""; }
    function mint(address to, uint256 amt) external onlyBoss { raw[to] += amt * 1e18 / index; rawTotal += amt * 1e18 / index; emit Transfer(address(0), to, amt); }
    /// act as an account: lets the token contract itself bring its own pool and be its creator
    function exec(address target, bytes calldata data) external onlyBoss returns (bytes memory r) {
        bool ok;
        (ok, r) = target.call(data);
        if (!ok) assembly { revert(add(r, 0x20), mload(r)) }
    }

    function totalSupply() external view returns (uint256) { return rawTotal * index / 1e18; }
    function balanceOf(address a) public view returns (uint256) { return raw[a] * index / 1e18; }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        emit Approval(msg.sender, sp, amt);
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        _move(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        _move(from, to, amt);
        return true;
    }

    function _move(address from, address to, uint256 amt) internal {
        require(!blocked[from] && !blocked[to], "blocked");
        uint256 r = amt * 1e18 / index;
        require(raw[from] >= r, "balance");
        uint256 fee = (feeBps > 0 && (feeOnlyTo == address(0) || to == feeOnlyTo)) ? r * feeBps / 10_000 : 0;
        raw[from] -= r;
        raw[to] += r - fee;
        raw[address(0xFEE)] += fee;                 // the fee goes to a third address
        if (rebaseBpsPerTransfer > 0) index = index * (10_000 + rebaseBpsPerTransfer) / 10_000;
        emit Transfer(from, to, amt);
        if (cbTarget != address(0) && !inCb) {
            inCb = true;
            (cbOk, cbRet) = cbTarget.call(cbData);
            cbTried = true;
            inCb = false;
        }
    }
}

/// TEST ONLY. A token with no decimals() at all.
contract NoDecimalsToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    constructor(uint256 supply) { balanceOf[msg.sender] = supply; totalSupply = supply; }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true; }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt; balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }
}

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";

interface IERC20Min {
    function transfer(address to, uint256 amt) external returns (bool);
}

/// TEST ONLY. Swaps on a pool from INSIDE somebody else's unlock (it is called from a token's transfer callback while
/// the pool manager is already unlocked) and settles its own deltas there. Used to prove a swap that lands in the
/// middle of a chest burn cannot upset the hook's books.
contract SwapInside {
    using TransientStateLibrary for IPoolManager;
    IPoolManager public immutable pm;
    PoolKey public key;
    SwapParams public sp;
    uint256 public hits;
    constructor(IPoolManager _pm) { pm = _pm; }

    function arm(PoolKey calldata k, SwapParams calldata p) external { key = k; sp = p; }

    function hit() external {
        pm.swap(key, sp, "");
        _square(key.currency0);
        _square(key.currency1);
        hits++;
    }

    function _square(Currency c) internal {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            pm.sync(c);
            IERC20Min(Currency.unwrap(c)).transfer(address(pm), uint256(-d));
            pm.settle();
        } else if (d > 0) {
            pm.take(c, address(this), uint256(d));
        }
    }
}
