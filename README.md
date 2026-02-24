# Mythic Bridge Relayer

Relays bridge transactions between Solana L1 and Mythic L2. Monitors deposit events on L1, confirms them, and triggers corresponding mint/unlock operations on L2. Handles withdrawal finalization from L2 back to L1.

## Architecture

- **L1 Watcher**: Polls the Solana L1 bridge program for new deposit events
- **L2 Watcher**: Monitors the Mythic L2 bridge program for withdrawal requests
- **Relayer**: Signs and submits bridge completion transactions using the sequencer key
- **Challenge Window**: Enforces the 42-hour challenge period for withdrawals

## Environment Variables

| Variable | Description |
|----------|-------------|
| `L1_RPC_URL` | Solana mainnet RPC endpoint |
| `L2_RPC_URL` | Mythic L2 RPC endpoint (default: `https://testnet.mythic.sh`) |
| `L1_BRIDGE_PROGRAM` | Bridge program ID on Solana L1 |
| `L2_BRIDGE_PROGRAM` | Bridge program ID on Mythic L2 |
| `SEQUENCER_KEY` | Path to sequencer keypair JSON |
| `POLL_INTERVAL_MS` | Polling interval in milliseconds (default: 5000) |

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your configuration
npm start
```

## Program IDs

- **L1 Bridge**: `oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ`
- **L2 Bridge**: `MythBrdgL2111111111111111111111111111111111`

## License

Proprietary - Mythic Labs
