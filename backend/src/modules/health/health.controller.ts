import { type RequestHandler } from 'express';

import { getLivenessSnapshot, getReadinessSnapshot } from './health.service.js';

export const getHealth: RequestHandler = (_req, res) => {
  res.status(200).json(getLivenessSnapshot());
};

export const getReadiness: RequestHandler = (_req, res) => {
  const snapshot = getReadinessSnapshot();

  res.status(snapshot.ready ? 200 : 503).json(snapshot.body);
};
