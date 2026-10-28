import mongoose from 'mongoose';
import { stagingConfig } from './utils/stagingConfig.js';

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

export default async function connectDB() {
  const { uri: MONGODB_URI, dbName } = stagingConfig();
  if (cached.conn && mongoose.connection.readyState === 1 && mongoose.connection.name === dbName && cached.uri === MONGODB_URI) {
    return cached.conn;
  }

  if (cached.uri && cached.uri !== MONGODB_URI && cached.promise) {
    throw new Error('Staging configuration changed; restart the backend before reconnecting.');
  }

  if (!cached.promise) {
    cached.uri = MONGODB_URI;
    cached.promise = mongoose.connect(MONGODB_URI, {
  dbName,
  serverSelectionTimeoutMS: 20000,
  connectTimeoutMS: 20000,
  family: 4,
  bufferCommands: false,
}).then((mongooseInstance) => {
      cached.conn = mongooseInstance;
      return mongooseInstance;
    }).catch(err => {
      cached.promise = null;
      throw new Error('Staging database connection failed. Check private configuration and Atlas network access.');
    });
  }

  try {
    cached.conn = await cached.promise;
    if (mongoose.connection.name !== dbName) throw new Error('Database identity mismatch; refusing database operations.');
    return cached.conn;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
}
