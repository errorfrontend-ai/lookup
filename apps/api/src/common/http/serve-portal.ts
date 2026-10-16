import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';

/** Vite's built files carry a hash of their content in their name, so they can be kept for a year. */
const HASHED_ASSET = /^\/assets\/[\w.-]+-[\w-]{8,}\.[a-z0-9]+$/;

/**
 * The station portal's own Content-Security-Policy: its scripts and styles from itself, Cloudflare's human check
 * (script and frame), and the object store for what the portal sends or shows straight from it — uploads (connect),
 * audio (media), logos (img) and licence documents (frame). Nothing else may load. On an https portal every http
 * address is upgraded too (never on a computer's own http address, which it would break).
 */
export function portalContentSecurityPolicy(objectStorageOrigin: string, isHttpsPortal: boolean): string {
  const humanCheck = 'https://challenges.cloudflare.com';
  return [
    "default-src 'self'",
    `script-src 'self' ${humanCheck}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${objectStorageOrigin}`,
    `media-src 'self' blob: ${objectStorageOrigin}`,
    `connect-src 'self' ${objectStorageOrigin}`,
    `frame-src ${humanCheck} ${objectStorageOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isHttpsPortal ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/**
 * Serves the built station portal from the API's own address (the showcase on Render), so the portal and the API
 * share one origin: the session cookies stay first-party and no proxy sits between them. Every GET that is not for
 * the API gets a file of the portal, or else index.html, and the portal's router decides what it shows. Hashed
 * assets are cached for a year; index.html is checked every time, so a new release is picked up at once. A path
 * outside the portal's folder is never read (`root`), and no dotfile or source map is served.
 */
export function servePortal(directory: string, contentSecurityPolicy: string) {
  if (!existsSync(join(directory, 'index.html'))) throw new Error(`PORTAL_STATIC_DIRECTORY has no index.html: ${directory}`);
  const sendIndex = (response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile('index.html', { root: directory }, (error) => {
      if (error) next(error);
    });
  };
  return (request: Request, response: Response, next: NextFunction): void => {
    const isApi = request.path === '/api' || request.path.startsWith('/api/');
    if (isApi || (request.method !== 'GET' && request.method !== 'HEAD')) {
      next();
      return;
    }
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    if (request.path === '/' || request.path === '/index.html') {
      sendIndex(response, next);
      return;
    }
    // Source maps are written for our own debugging; they are never served, so the original source stays private.
    if (request.path.endsWith('.map')) {
      next(new AppError('NOT_FOUND', { internalDetail: 'a source map of the portal' }));
      return;
    }
    const isHashed = HASHED_ASSET.test(request.path);
    response.sendFile(request.path, { root: directory, dotfiles: 'deny', index: false, maxAge: isHashed ? '365d' : 0, immutable: isHashed }, (error) => {
      if (!error) return;
      if (response.headersSent) {
        next(error);
        return;
      }
      // A missing build file is a 404; any other path is a page of the portal (a station page, a sign-in link …).
      if (request.path.startsWith('/assets/')) {
        next(new AppError('NOT_FOUND', { internalDetail: 'a build file the portal does not have' }));
        return;
      }
      sendIndex(response, next);
    });
  };
}
