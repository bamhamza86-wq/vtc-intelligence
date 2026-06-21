const Database = require('better-sqlite3');
const db = new Database('data.db');
db.prepare("UPDATE platform_credentials SET api_key=?, status='connected' WHERE platform='tomtom'").run('FAKE_TEST_KEY_1234567890');
const row = db.prepare("SELECT platform, api_key, status FROM platform_credentials WHERE platform='tomtom'").get();
console.log('tomtom cred:', JSON.stringify(row));
db.close();
