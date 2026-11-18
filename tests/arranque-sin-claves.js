'use strict';
// Lo usa servidor.test.js: arranca el servidor con una base simulada VACÍA y un .env sin claves válidas (debe negarse a arrancar).
const { MongoClientFalso } = require('./mongo-falso');
const ruta = require.resolve('mongodb');
require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports: { MongoClient: MongoClientFalso } };
Object.assign(process.env, { MONGODB_URI: 'mongodb://falso', DATA_KEY: Buffer.alloc(32, 7).toString('base64'), PORT: '38918' });
require('../server.js');
