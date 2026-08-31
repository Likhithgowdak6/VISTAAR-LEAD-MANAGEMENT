import mongoose, { type Connection } from 'mongoose';

import { env } from './env.js';

/** Partial on purpose: Mongoose also reports 99 ("uninitialized"), which maps to 'unknown'. */
const CONNECTION_STATES: Readonly<Partial<Record<number, string>>> = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
});

let connectionPromise: Promise<Connection> | null = null;

export interface DatabaseStatus {
  ready: boolean;
  state: string;
}

export type DatabaseSession = Parameters<Parameters<Connection['transaction']>[0]>[0];

export type TransactionCommand<Result> = (session: DatabaseSession) => Promise<Result>;

export const runInTransaction = <Result>(command: TransactionCommand<Result>): Promise<Result> =>
  mongoose.connection.transaction(command, {
    readPreference: 'primary',
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });

export const connectDatabase = async (): Promise<Connection> => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = mongoose
    .connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    })
    .then(() => mongoose.connection)
    .finally(() => {
      connectionPromise = null;
    });

  return connectionPromise;
};

export const disconnectDatabase = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
};

export const getDatabaseStatus = (): DatabaseStatus => {
  const state = mongoose.connection.readyState;

  return {
    ready: state === 1,
    state: CONNECTION_STATES[state] ?? 'unknown',
  };
};
