#!/bin/bash
set -e
cd /home/user/workspace/vtc-repo
pkill -f "dist/index.cjs" 2>/dev/null || true
sleep 1
PORT=5099 NODE_ENV=production node dist/index.cjs > /tmp/server.log 2>&1 &
SRV=$!
sleep 8

echo "=== LOGIN ==="
LOGIN=$(curl -s -X POST http://localhost:5099/api/auth/login -H "Content-Type: application/json" -d '{"username":"root","password":"12345678"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
echo "token: ${TOKEN:0:16}..."

echo ""
echo "=== /api/routing-status ==="
curl -s http://localhost:5099/api/routing-status -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

echo ""
echo "=== /api/gmaps-distances/status ==="
curl -s http://localhost:5099/api/gmaps-distances/status -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('cacheSource:',d.get('cacheSource'),'| ttlMinutes:',d.get('ttlMinutes'),'| secondsUntilNext:',d.get('secondsUntilNext'))"

echo ""
echo "=== /api/best-route (distanceSource in top5) ==="
curl -s -X POST http://localhost:5099/api/best-route -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"lat":48.8976,"lng":2.3299}' | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('top5',[]); print('top5 count:',len(t)); [print(' -',z['zone']['name'],'| eta',z['etaMinutes'],'min | src:',z.get('distanceSource')) for z in t[:3]]"

echo ""
echo "=== /api/idle-optimizer (distance_source) ==="
curl -s "http://localhost:5099/api/idle-optimizer?lat=48.8976&lng=2.3299" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('recommendations',[]); print('recos:',len(r)); [print(' -',x['zone_name'],'| eta',x['eta_min'],'| src:',x.get('distance_source')) for x in r[:3]]"

echo ""
echo "=== /api/routing-cache/stats (tomtomHits field) ==="
curl -s http://localhost:5099/api/routing-cache/stats -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('tomtomHits:',d.get('tomtomHits'),'| osrmHits:',d.get('osrmHits'),'| tomtomAvailable:',d.get('tomtomAvailable'),'| ttlMinutes:',d.get('ttlMinutes'))"

kill $SRV 2>/dev/null || true
echo ""
echo "=== DONE ==="
