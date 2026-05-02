import { Request, Response, NextFunction } from 'express';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';

// Attach a unique request ID to every request
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || uuidv4();
  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);
  next();
}

// Morgan HTTP logger
export const httpLogger = morgan(
  ':method :url :status :res[content-length] - :response-time ms [:date[iso]]',
  {
    skip: (_req, res) => res.statusCode < 400, // in production, skip successful requests
  }
);

export const httpLoggerDev = morgan('dev');
