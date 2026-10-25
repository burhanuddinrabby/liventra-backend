# AGENTS.md — Liventra Backend

MERN livestock-farm management REST API: TypeScript + Express 5 + Mongoose 9 + Zod v4 + JWT. Single package, ESM (`"type": "module"`). No README; frontend is a separate Vite app (not here).

## Commands

- **Dev**: `npm run dev` (`tsx watch ./src/server.ts`). Run from the repo root — `dotenv` and multer resolve paths from `process.cwd()`.
- **Typecheck**: `npx.cmd tsc --noEmit` (no npm script, currently clean). On this machine the `npx` ps1 shim is blocked by PowerShell policy; always use `npx.cmd`.
- **Lint**: `npx.cmd eslint src` — exits 1 with 2 pre-existing errors (`no-unused-vars` on unused `next` in `globalErrorHandler.ts`/`notFound.ts`) plus warnings. Don't chase them. `npm run lint:fix` is broken (delegates to a nonexistent `lint` script).
- **Format**: `npm run format` (prettier, respects `.gitignore`).
- **Test**: none configured; `npm test` exits 1. Don't invent test commands.
- **Build**: no build script — `npx.cmd tsc`, then `npm run start:prod` (`node ./dist/server.js`).

## Architecture

- `src/server.ts` → connect Mongo (`MONGO_URL`), fire-and-forget `seedSuperAdmin()`, listen on `PORT` → exports `src/app.ts`.
- `src/app.ts`: `express.json` + cookie-parser + CORS (only `localhost:5173` and `192.168.56.1:5173`, `credentials: true`) → `/api/v1` → `src/app/routes/index.ts`, which mounts modules by path (`/users`, `/farms`). Catch-all must stay `app.all('{*splat}', notFound)` — path-to-regexp v8 syntax, `'*'` throws.
- Modules live in `src/app/modules/<name>/`: `*.route.ts`, `.controller.ts`, `.services.ts`, `.model.ts`, `.validation(s).ts`, `.interface.ts`, `.constants.ts`, `.utils.ts`; each exports an object (`userRouter`, `UserController`, `UserServices`, `farmValidations`). Newest reference implementation is `farm` (its unimplemented routes are commented out inline in route/controller/services — uncomment + implement rather than rewriting from scratch).
- `src/app/builder/QueryBuilder.ts` drives list endpoints: `.search([...]).filter().sort().paginate().fields()`, then `await countTotal()` and `await modelQuery` (run both in `Promise.all`).
- Two ID styles: users have a custom string `userId` (`U-YY-NNNN`), farms have `farmId` (`FARM-NNNNN`). JWT carries that string `userId`, but `Farm.ownerId` is a Mongoose `ObjectId` — farm services must look the user up (`UserModel.findOne({ userId })`) and use `_id`.
- Roles: `SystemRoles` = `user` / `admin` / `superAdmin` (`src/app/modules/auth/auth.constants.ts`). `TSystemRole` is `keyof typeof SystemRoles` (uppercase keys), so don't use it for stored values.

## Conventions

- Relative imports always end in `.js`; type-only imports use `import type` (`verbatimModuleSyntax`). tsconfig is strict with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, `include: ["src"]`.
- Handlers: `catchAsync` + `sendResponse(res, { statusCode, success, message, data, meta? })`; throw `new AppError(status.X, 'msg')`; status codes from `http-status`.
- `globalErrorHandler` handles ZodError, Mongoose `ValidationError`/`CastError`, duplicate key `11000`, `TokenExpiredError`, `AppError`; response is `{ success, message, errorSources, err, stack }` (stack only when `NODE_ENV=development`).
- Zod is **v4**: use `z.email()` (top-level), not `z.string().email()`.
- `validateRequest(schema)` only validates `{ body, cookies }` — never params or query. It also **discards** the parsed result, so coercions/defaults/transforms never reach handlers and unknown keys aren't stripped. Validate at the service layer or coerce manually (farm does this for `establishedDate`).
- `auth(...roles)` reads `Authorization: Bearer <token>`, verifies with `JWT_SECRET`, sets `req.user = { userId, role }` (typed globally in `src/app/interfaces/index.d.ts`). It does not check `isActive`/`isDeleted` — deactivated users keep working until the token expires. `auth()` with **no roles denies everyone** (empty array is truthy).
- Login accepts either email or phone in the `email` field; `refreshToken` is set as an httpOnly cookie *and* returned in the body.
- Uploads: multer field name `file`, disk storage to `<cwd>/uploads` (must exist; it is **not** git-ignored, so temp files show in `git status`); `uploadImageToCloudinary(name, path)` uploads then deletes the local file. `POST /users/register-user` is multipart with a `data` field holding the JSON body, parsed inline in `auth.route.ts`.

## Gotchas

- `userSchema.pre('save')` re-hashes `password` on **every** save (`auth.model.ts`). Use `findOneAndUpdate`/`updateOne` for any user update; only call `.save()` when intentionally assigning a new plain password (change-password, reset-password rely on this).
- Soft delete is only a convention now: the `pre(['find','findOne'])` `isDeleted` filter in `auth.model.ts` is **commented out**, and `DELETE /users/:id` just sets `isActive: false, isDeleted: true`. Services filter `isDeleted` explicitly (e.g. `getAllUsers`, farm owner lookup). If you re-enable such a hook, use `this.where()` — `this.find()` mutates `query.op` and breaks post-hook dispatch.
- ID generators are last-row+1 and non-atomic (`generateUserId` in `auth.utils.ts`, `generateFarmId` in `farm.utils.ts`); unique indexes catch collisions. `generateFarmId` is buggy: it calls `find(...).sort({...})` on an array (sort is a no-op) and takes `[0]` — copy the `UserModel.findOne().sort({ createdAt: -1 })` pattern instead.
- Farm creation (`farm.services.ts`) requires an active user with `emailVerified: true`, rejects a second `Setup` farm and duplicate `farmName` per owner. Enum values are display strings: `FarmStatuses.ARCHIVED === "Suspended"`, `"Setup"`, `"Active"`, `"Inactive"`.
- User creation returns **200**, not 201; profile updates use dotted paths (`address.upazila`) to avoid clobbering the address subdocument.
- Email verification OTPs: 6 digits, 2-minute TTL, only a sha256 hash stored, 5 wrong attempts burn the code. TTL index is declared with `{ expireAfterSeconds: 0 }` — mongoose's `{ expires: 0 }` sugar is falsy-skipped and creates a plain index. The same `verify-email` endpoint sends a code when `otp` is omitted.
- `.env` is loaded from `process.cwd()/.env`. Required: `MONGO_URL`; `SUPER_ADMIN_PASS` (`src/app/DB/index.ts` throws at import and seeds `U-00-0000` on startup); `BCRYPT_SALT` (missing → `Number(undefined)` → bcrypt throws on every save); `JWT_SECRET`/`JWT_SECRET_EXP`/`JWT_REFRESH_SECRET`/`JWT_REFRESH_SECRET_EXP`; `SMTP_USER`/`SMTP_PASS` and `RESET_UI_LINK` for emails; `CLOUDINARY_NAME`/`CLOUDINARY_KEY`/`CLOUDINARY_SECRET` for images. `NODE_ENV` controls cookie `secure` and stack traces.
- Never commit `.env` (git-ignored: DB URI, JWT secrets, SMTP + Cloudinary creds). Also git-ignored: `dist/`, `node_modules/`, `.opencode/`.

## Spec and doc sources

- `.opencode/Business Logic MDs/` — 28 numbered domain specs (`01_User` … `28_Report`); read the relevant one before building a module (local only, git-ignored).
- `api_documentation/auth.md` — hand-written endpoint docs for the users/auth API; keep it in sync when changing those routes.
- `todos.md` — current dev todos (Bengali).
