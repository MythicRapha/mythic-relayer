#\!/bin/bash
set -e

echo "=== Post-Finalize: Checking withdrawal status ==="
cd /mnt/data/mythic-relayer

# Check if withdrawal has been finalized
STATUS=$(sqlite3 data/relayer.db "SELECT status FROM withdrawals WHERE id='19caaca4c1d-5a5e6fdb';")
echo "Withdrawal status: $STATUS"

if [ "$STATUS" = "completed" ]; then
  echo "Withdrawal already finalized\!"
elif [ "$STATUS" = "initiated" ]; then
  echo "Still initiated — waiting for relayer to finalize..."
  echo "Challenge expires at: $(sqlite3 data/relayer.db "SELECT datetime(challenge_expires_at, 'unixepoch') FROM withdrawals WHERE id='19caaca4c1d-5a5e6fdb';")"
  echo "Current time: $(date -u)"
  echo "Will check again in 5 min..."
  exit 1
fi

# Step 1: Restore L1 challenge period to 86400
echo ""
echo "=== Step 1: Restoring L1 challenge period to 86400 (24h) ==="
node restore-challenge-period.mjs

# Step 2: Update .env
echo ""
echo "=== Step 2: Updating .env ==="
sed -i 's/L1_CHALLENGE_PERIOD_SECONDS=3600/L1_CHALLENGE_PERIOD_SECONDS=86400/' .env
grep CHALLENGE .env

# Step 3: Rebuild and restart relayer
echo ""
echo "=== Step 3: Rebuilding and restarting relayer ==="
npm run build 2>&1 | tail -5
pm2 restart mythic-relayer

echo ""
echo "=== All done\! ==="
