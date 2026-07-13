# StagLocker — Blockscout verification bundle

Contract: **0x6F69fEbE30ba7348901a523bcc9a6fAA5b493160** (Robinhood Chain 4663)
Deployed & on-chain config confirmed: owner=admin, burn 2M/30d, cap 24M, free>=10M .

## Exact inputs
- **Method:** Solidity (Standard JSON Input)
- **Compiler:** `v0.8.24+commit.e11b9ed9`
- **Optimization:** enabled, 200 runs · **viaIR:** true · **EVM:** paris  (already inside the JSON)
- **Contract name:** `contracts/StagLocker.sol:StagLocker`
- **Standard-JSON file:** `standard-input.json` (in this folder)
- **Constructor args (ABI-encoded, no 0x):**
```
00000000000000000000000073991a25c818bf1f1128deaab1492d45638de0d30000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b6a5059356332a0b222e9d21b1f72f3617d12516000000000000000000000000b6a5059356332a0b222e9d21b1f72f3617d12516
```
  (= positionManager 0x73991a25c818bf1f1128deaab1492d45638de0d3, flatFeeWei 0, feeRecipient 0xb6A5…12516, admin 0xb6A5…12516)

## Two ways to submit
1. **Browser (most reliable on this explorer):** open the contract on Blockscout → Code tab → "Verify & Publish" → "Standard JSON Input" → set compiler `v0.8.24+commit.e11b9ed9` → upload `standard-input.json` → paste the constructor args above → Verify.
2. **CLI (Etherscan-compatible), once the explorer's API is up:**
```
curl -X POST "https://robinhoodchain.blockscout.com/api?module=contract&action=verifysourcecode" \
  --data-urlencode codeformat=solidity-standard-json-input \
  --data-urlencode contractaddress=0x6F69fEbE30ba7348901a523bcc9a6fAA5b493160 \
  --data-urlencode "contractname=contracts/StagLocker.sol:StagLocker" \
  --data-urlencode compilerversion=v0.8.24+commit.e11b9ed9 \
  --data-urlencode constructorArguements=00000000000000000000000073991a25c818bf1f1128deaab1492d45638de0d30000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b6a5059356332a0b222e9d21b1f72f3617d12516000000000000000000000000b6a5059356332a0b222e9d21b1f72f3617d12516 \
  --data-urlencode sourceCode@standard-input.json
```
