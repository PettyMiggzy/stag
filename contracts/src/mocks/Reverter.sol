// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Test-only: a contract that always reverts on ETH receipt. Used to prove best-effort payout
// paths (collector splits, splitter forwarding) can't be bricked by a hostile recipient.
contract Reverter {
    receive() external payable { revert("reverter: no eth"); }
}
