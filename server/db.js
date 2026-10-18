import mongoose from 'mongoose';

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

export default async function connectDB() {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  // Read MONGODB_URI here (inside the function), not at module load time. Reading it at
  // import time was the root cause of "the uri parameter to openUri() must be a string,
  // got undefined": db.js used to be imported (and its top-level code evaluated) before
  // server.js's dotenv.config() call had run, so it permanently cached whatever
  // process.env.MONGODB_URI was at that premature moment. Reading it fresh inside this
  // function also means a real MONGODB_URI set directly on the hosting platform (e.g. a
  // Vercel project environment variable, which never goes through a .env file) is picked
  // up correctly.
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI is not set. Add it to your .env file (see .env.example) or to your ' +
      'hosting platform\'s environment variables, then restart the server.'
    );
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 20000,
  connectTimeoutMS: 20000,
  family: 4,
  bufferCommands: false,
}).then((mongooseInstance) => {
      cached.conn = mongooseInstance;
      return mongooseInstance;
    }).catch(err => {
      cached.promise = null;
      throw err;
    });
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
}
