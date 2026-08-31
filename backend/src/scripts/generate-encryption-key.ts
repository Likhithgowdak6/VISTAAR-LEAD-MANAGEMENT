import crypto from 'node:crypto';

const key = crypto.randomBytes(32).toString('base64');

console.log('Generated local development encryption key.');
console.log('');
console.log('Add this to backend/.env only:');
console.log('');
console.log(`ENCRYPTION_KEY_V1=${key}`);
console.log('');
console.log('Do not commit this value.');
console.log('Do not paste production keys into chat.');
