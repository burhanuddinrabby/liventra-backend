# AGENTS.md — Liventra Backend

## Project Overview

MERN smart livestock farm management API: TypeScript + Express 5 + Mongoose 9 + Zod v4 + JWT auth. Single package, ESM (`"type": "module"`). Frontend is a separate Vite app (not in this repo).

## Commands

- **Dev**: `npm run dev` — `tsx watch ./src/server.ts`; requires `.env`
- **Typecheck**: `npx.cmd tsc --noEmit` — no npm script. On this machine `npx` (ps1 shim) is blocked by PowerShell execution policy; use `npx.cmd`
- **Lint**: `npx.cmd eslint src` — currently fails with 2 pre-existing errors (`no-unused-vars` on unused `next` params in `globalErrorHandler.ts`/`notFound.ts`) + warnings; don't mistake them for your regressions. `npm run lint:fix` is broken (delegates to a nonexistent `lint` script)
- **Format**: `npm run format` (prettier, respects `.gitignore`)
- **Test**: none configured; `npm test` exits 1. Don't invent test commands
- **Build**: no build script; run `npx.cmd tsc`, then `npm run start:prod` (`node ./dist/server.js`)

## Architecture

- Entry: `src/server.ts` → connects Mongo (`MONGO_URL`), calls `seedSuperAdmin()` (not awaited), listens on `PORT` (5000) → exports `src/app.ts`
- `src/app.ts`: `express.json` + cookie-parser + CORS (`http://localhost:5173`, `http://192.168.56.1:5173`, `credentials: true`) → `/api/v1` → `src/app/routes/index.ts`. Express 5 catch-all is `app.all('{*splat}', notFound)` — path-to-regexp v8 syntax, not `*`
- Module pattern: `src/app/modules/<name>/` with `auth.route.ts`, `auth.controller.ts`, `auth.services.ts`, `auth.model.ts`, `auth.validation.ts`, `auth.interface.ts`, `auth.constants.ts`; each file exports an object (`userRouter`, `UserController`, `UserServices`, `userValidations`)
- Only the `auth` module exists so far (users + auth endpoints). Remaining planned endpoints are listed in the comment block at the bottom of `auth.route.ts`
- `src/app/builder/QueryBuilder.ts` powers paginated lists: `.search(fields).filter().sort().paginate().fields()` then `.countTotal()` + `.modelQuery`
- Domain types live in `*.interface.ts` (plain `.ts`); only `src/app/interfaces/index.d.ts` is a declaration file — it globally adds `req.user: JwtPayload` to Express

## Gotchas

- **ESM + `module: nodenext`**: every relative import must end in `.js`, even though sources are `.ts`. `verbatimModuleSyntax` — type-only imports must use `import type { ... }`
- **tsconfig**: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; `include: ["src"]` only
- **Zod is v4** (`zod ^4.4.3`) — don't copy v3 APIs
- **`validateRequest(schema)` only validates `{ body, cookies }`** — never params/query. `req.params.id` is unvalidated; services 404 on unknown ids
- **`userSchema.pre('save')` re-hashes `password` on every save** (`auth.model.ts`) — use `findOneAndUpdate` for updates; only call `.save()` when intentionally setting a new plain password (change-password depends on this)
- **Soft delete**: `pre(['find', 'findOne'])` auto-injects `isDeleted: false`. In query pre hooks use `this.where()` — `this.find()` mutates `query.op` (breaks post-hook dispatch). Side effect: `generateUserId()` can't see deleted users, so a new user can collide with a soft-deleted `userId` (unique index)
- **Auth middleware**: `auth(...roles)` reads `Authorization: Bearer <accessToken>`, sets `req.user` (`{ userId, role }`)
- **Uploads**: multer field name `file`, disk storage to `uploads/` (repo root — **not** git-ignored, temp files can show up in `git status`); `uploadImageToCloudinary(name, path)` uploads to Cloudinary and deletes the local file. Multipart routes: register-user also sends a `data` field holding a JSON string, parsed inline in `auth.route.ts`
- **House style**: async handlers wrapped in `catchAsync`; responses via `sendResponse(res, { statusCode, success, message, data })`; errors via `new AppError(status.X, 'msg')`; `globalErrorHandler` handles ZodError, Mongoose ValidationError/CastError, duplicate key 11000, TokenExpiredError, AppError; status codes from the `http-status` package
- **`.env` required at boot**: `MONGO_URL` (server throws if missing) and `SUPER_ADMIN_PASS` (module `src/app/DB/index.ts` throws at import if unset — seeds super admin `U-00-0000` on startup). Auth needs `JWT_SECRET(_EXP)` + `JWT_REFRESH_SECRET(_EXP)`; images need `CLOUDINARY_NAME/KEY/SECRET`
- **Never commit `.env`** (git-ignored; contains DB URI, JWT secrets, Cloudinary + SMTP creds). `dist/`, `node_modules/`, `.opencode/` are also git-ignored

## Spec sources

- `.opencode/Business Logic MDs/` — 28 domain specs (`01_User` … `28_Device`/`Report`); read the relevant one before implementing a new module (local only, git-ignored)
- `todos.md` — current dev todos
