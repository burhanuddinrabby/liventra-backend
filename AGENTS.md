# AGENTS.md — Liventra Backend

## Project Overview

MERN-based smart livestock farm management API. TypeScript + Express 5 + Mongoose 9, with Zod validation and JWT auth.

## Commands

- **Dev**: `npm run dev` — runs `tsx watch ./src/server.ts` (requires `.env` present)
- **Production**: `npm run start:prod` — runs `node ./dist/server.js` (requires prior `tsc` build)
- **Format**: `npm run format` — `prettier --ignore-path .gitignore --write "./src/**/*.+(js|ts|json)"`
- **Lint**: `npm run lint --fix` — note: `npm run lint` (without `--fix`) is **not defined** in package.json; only `lint:fix` exists
- **Test**: Not configured. `npm test` exits with error.
- **Type-check**: `npx tsc --noEmit` (no script defined in package.json)

## Architecture

- **Entry**: `src/server.ts` → imports `src/app.ts` (Express app)
- **Module pattern**: `src/app/modules/<module>/` contains route/controller/service/model/interface/validation/constants/utils
- **Current modules**: Only `auth` is implemented (register-user, login endpoints)
- **Routes**: `src/app/routes/index.ts` mounts module routers under `/api/v1`
- **Middleware**: `validateRequest` (Zod), `auth` (JWT + role), `globalErrorHandler`, `notFound`, `catchAsync`
- **Config**: `src/app/config/index.ts` loads `.env` via `dotenv`
- **TypeScript**: `"type": "module"` (ESM), strict mode, `rootDir: ./src`, `outDir: ./dist`

## Key Constraints

- **`.env` is in `.gitignore`** — do not commit it; it contains MongoDB URI, JWT secrets, Cloudinary keys, SMTP creds
- **`.opencode/` is a separate project** (its own `package.json` with `@opencode-ai/plugin`) — not the backend source
- **`dist/` is in `.gitignore`** — build artifacts are not committed
- **No test framework** installed; adding tests requires installing a framework
- **`lint` script is missing** from package.json — only `lint:fix` exists (it delegates to `npm run lint --fix`, which will fail since `lint` is undefined)

## Coding Conventions

- Use `catchAsync` wrapper for async route handlers
- Use `validateRequest` with Zod schemas for input validation
- Use `sendResponse` for standardized JSON responses
- Use `AppError` for custom errors with status codes
- Error handling: `globalErrorHandler` catches ZodError, ValidationError, CastError, duplicate key (11000), TokenExpiredError, and generic AppError/Error
- Auth middleware: `auth(...roles)` checks JWT and role membership
- Interface files use `.d.ts` extension (`src/app/interfaces/`)
- Mongoose models exported as `ModelName` (e.g., `UserModel`)

## Environment

- Port: 5000 (from `.env`)
- CORS origins: `http://localhost:5173`, `http://192.168.56.1:5173` (Vite frontend)
- MongoDB connection via `MONGO_URL` in `.env`
- Cloudinary for image uploads (files go to `uploads/` dir)
- SMTP for email (Gmail transport)
