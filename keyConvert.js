//keyConvert.js
const fs = require('fs');

// JSON file এবং parse
const keyData = fs.readFileSync('./anis-abaiya-firebase-admin-key.json', 'utf8');
const keyObject = JSON.parse(keyData);

// Object কে string এ convert ( formatting ok)
const keyString = JSON.stringify(keyObject);

// Base64 encode 
const base64 = Buffer.from(keyString).toString('base64');

console.log('\nCopy this base64 string to your .env file:\n');
console.log(base64);
console.log('\n');