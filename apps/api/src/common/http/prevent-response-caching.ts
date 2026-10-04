import type { NextFunction, Request, Response } from 'express';

/** API responses carry account and station data: never let a browser or proxy cache them. */
export function preventResponseCaching(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('Cache-Control', 'no-store');
  next();
}
