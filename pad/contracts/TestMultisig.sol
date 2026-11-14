// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// TEST ONLY: stands in for a Safe: a contract that can execute arbitrary calls when its (single) signer says so.
contract TestMultisig {
    address public immutable signer;
    constructor(address s) { signer = s; }
    function exec(address to, bytes calldata data) external returns (bytes memory r) {
        require(msg.sender == signer, "not signer");
        bool ok;
        (ok, r) = to.call(data);
        if (!ok) { assembly { revert(add(r, 32), mload(r)) } }
    }
}
