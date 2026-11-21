# AGENTS.md — Liventra Backend

Livestock-farm management REST API: TypeScript + Express 5 + Mongoose 9 + Zod v4 + JWT, single package, ESM (`"type": "module"`). No README. The client is the separate Next.js repo at `../frontend` (see `../frontend/CLAUDE.md`); its `app/lib/api.ts` mirrors this API's response envelope, error shape, and multipart field names, so keep it in mind when changing those.

## Commands (run from this `Backend/` directory)

- **Dev**: `npm run dev` (`tsx watch ./src/server.ts`). Must run from `Backend/`: `dotenv` reads `<cwd>/.env` and multer writes `<cwd>/uploads`.
- **Typecheck**: `npx.cmd tsc --noEmit` (no npm script; verified clean). PowerShell blocks the `npx.ps1` shim on this machine, so use `npx.cmd`.
- **Lint**: `npx.cmd eslint src`. Expect exit 1 from 2 pre-existing `no-unused-vars` errors (`next` in `globalErrorHandler.ts`/`notFound.ts`) plus warnings — don't chase them. `npm run lint:fix` is broken (delegates to a nonexistent `lint` script).
- **Format**: `npm run format`. There is no Prettier config, so defaults (2 spaces, double quotes) rewrite the existing 4-space/single-quote files; avoid repo-wide formatting in feature diffs.
- **Test**: none configured; `npm test` exits 1. Don't invent test commands.
- **Build/prod**: no build script — `npx.cmd tsc`, then `npm run start:prod` (`node ./dist/server.js`).

## Architecture

- `src/server.ts` connects Mongo (`MONGO_URL`), fire-and-forgets `seedSuperAdmin()` and `FarmMemberServices.syncOwnedFarmMemberships()`, then listens on `PORT`. It is not the Express app — `src/app.ts` is.
- `src/app.ts`: `express.json` + cookie-parser + `cors({ origin: '*', credentials: true })`, mounts `/api/v1` → `src/app/routes/index.ts`. The wildcard origin is invalid for credentialed browser requests; use an explicit origin list if cookies must work from a browser. Keep the catch-all as `app.all('{*splat}', notFound)` — path-to-regexp v8 syntax; `'*'` throws.
- Mounted routes: `/users` (auth/profile/admin), `/farms` (farm CRUD + nested `/:farmId/members` → `farmMemberRouter` and `/:farmId/animals` → `animalRouter`), `/breeds`, `/feed-ingredients` (global master catalog; audited writes via `auditLog/auditLog.utils.ts` `recordAuditLog()`, best-effort, atomic `LOG-000001` counter), `/feed-formulas` (global feeding blueprints: server-calculated nutrition/cost, one active default per exact context via partial unique index, scientific edits on a formula referenced by `feedrecommendations` create a new version record; `/match` ranks formulas for an animal context).
- Modules live in `src/app/modules/<name>/`: `*.route.ts`, `.controller.ts`, `.services.ts`, `.model.ts`, `.validation(s).ts`, `.interface.ts`, `.constants.ts`, `.utils.ts`; each exports an object (`userRouter`, `UserController`, `UserServices`, `farmValidations`).
- `breed` is the newest and cleanest reference: service-layer field whitelisting/coercion, generated immutable `breedCode`, deactivate-instead-of-delete. `farm` remains the reference for farm-scoped RBAC; its unimplemented routes are commented out inline in route/controller/services — uncomment and implement rather than rewriting.
- `src/app/builder/QueryBuilder.ts` drives list endpoints: `.search([...]).filter().sort().paginate().fields()`, then `await Promise.all([query.countTotal(), query.modelQuery])`. `search()` interpolates `searchTerm` straight into `$regex` — escape user input first (see `escapeRegex` in `breed.utils.ts`).

## IDs, auth and farm RBAC

- Generated display IDs: users `U-YY-NNNN`, farms `FARM-NNNNN`, breeds `BREED-00001`, feed ingredients `ING-00001`, feed formulas `FF-000001`. All are last-row+1 and non-atomic; the unique index is the real guard, so retry on duplicate key 11000.
- JWTs carry `{ userId, role }` where `userId` is the custom string. `Farm.ownerId` and `FarmMember.userId` are ObjectIds — services look the user up (`UserModel.findOne({ userId })`) and use `_id`.
- `auth(...roles)` verifies the token, then loads the user and rejects inactive accounts; role checks use the DB `systemRole`, not the token. `auth()` with no roles allows any logged-in user. It does not check `isDeleted`, and `/users/login` does not check active/deleted before issuing tokens.
- Farm-scoped authorization is service-layer: `resolveFarmAccess` in `farmMember.service.ts` requires an active `FarmMember` row. Only platform `superAdmin` and the farm's `Farm.ownerId` account bypass it (treated as `Owner`); platform `admin` does **not** bypass. Owner/Manager manage members; only Owner (or superAdmin/owner account) deletes.
- `FarmMember`: one *active* membership per `(farmId, userId)` via partial unique index; inactive rows are history. `nid`/`salary` are `select: false` and management-only. `Farm.ownerId` must always have an active `Owner` row — created on farm creation, backfilled at startup (`syncOwnedFarmMemberships`), and re-synced on ownership transfer (old owner → `Manager`).
- `SystemRoles` = `user` / `admin` / `superAdmin` (`auth.constants.ts`). `TSystemRole` is `keyof typeof SystemRoles` (uppercase keys), so don't use it for stored values.

## Conventions

- Relative imports end in `.js`; type-only imports use `import type` (`verbatimModuleSyntax`). tsconfig is strict with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, `include: ["src"]`.
- Handlers: `catchAsync` + `sendResponse(res, { statusCode, success, message, data, meta? })`; throw `new AppError(status.X, 'msg')`; status codes from `http-status`.
- `globalErrorHandler` maps ZodError, Mongoose `ValidationError`/`CastError`, duplicate key `11000`, `TokenExpiredError`, `AppError`; response is `{ success, message, errorSources, err, stack }` (stack only when `NODE_ENV=development`).
- Zod is **v4**: use top-level `z.email()`, not `z.string().email()`.
- `validateRequest(schema)` validates only `{ body, cookies }` and **discards** the parsed result: coercions/defaults/transforms never reach handlers and unknown keys aren't stripped. Whitelist/coerce in the service (breed pattern) or filter manually. It never validates params or query, so services must parse those themselves (`QueryBuilder` receives raw strings).
- Multipart field names differ by module: users `file`, farms `logo`, breeds `image`, animals `profilePhoto` + `gallery`. User/farm creation put the JSON body in `data` and parse it inline (`JSON.parse(req.body.data)`, no guard).
- Uploads: multer writes to `<cwd>/uploads` (not git-ignored), `uploadImageToCloudinary(name, path)` uploads then deletes the local file.

## Gotchas

- `userSchema.pre('save')` re-hashes `password` on **every** save. Use `findOneAndUpdate`/`updateOne` for user updates; only call `.save()` when intentionally assigning a new plain password (change-password and reset-password rely on this).
- Soft delete is only a convention: the `isDeleted` filter hook in `auth.model.ts` is commented out, and `DELETE /users/:id` just sets `isActive: false, isDeleted: true`. Services filter `isDeleted` explicitly. If you re-enable such a hook, use `this.where()` — `this.find()` mutates `query.op` and breaks post-hook dispatch.
- Farm creation requires an active, `emailVerified` user, rejects a second `Setup` farm, and rejects duplicate `farmName` per owner. If the Owner-membership insert fails, the new farm is deleted (compensating workflow).
- Enum values are display strings stored as-is: `FarmStatuses.ARCHIVED === "Suspended"`; farm roles are `Owner/Manager/Worker/Veterinarian/Accountant`; breeds are deactivated via `PATCH /breeds/:id/status`, never hard-deleted.
- Breed names are unique case-insensitively (`collation: { locale: "en", strength: 2 }`) by both index and pre-check; `breedCode` is immutable. Breed route order matters: `/lookup`, `/meta`, `/stats`, `/code/:breedCode` must stay above `/:id`.
- User creation returns **200**, not 201. Profile updates use dotted paths (`address.upazila`) so the address subdocument is not clobbered.
- Email OTPs: 6 digits, 2-minute TTL, only a sha256 hash stored, 5 wrong attempts burn the code. The TTL index uses `{ expireAfterSeconds: 0 }`; mongoose's `{ expires: 0 }` is falsy-skipped and creates a plain index. Registration does **not** send an OTP — the client must call `POST /users/verify-email` without `otp` to request one.
- `.env` is loaded from `<cwd>/.env`. Required: `MONGO_URL`; `SUPER_ADMIN_PASS` (`src/app/DB/index.ts` throws at import and seeds `U-00-0000`); `BCRYPT_SALT` (missing → `Number(undefined)` → bcrypt throws on every save); `JWT_SECRET`/`JWT_SECRET_EXP`/`JWT_REFRESH_SECRET`/`JWT_REFRESH_SECRET_EXP`; `SMTP_USER`/`SMTP_PASS` + `RESET_UI_LINK` for email; `CLOUDINARY_NAME`/`CLOUDINARY_KEY`/`CLOUDINARY_SECRET` for images. `NODE_ENV` controls cookie `secure` and stack traces.
- Never commit `.env` (DB URI, JWT secrets, SMTP + Cloudinary creds). Git-ignored: `.env`, `.opencode`, `node_modules`, `dist`.

## Spec and doc sources

- `.opencode/Business Logic MDs/Liventra_Business_Logic_NN_<Domain>.md` — 28 numbered domain specs (`01_User` … `28_Report`); read the relevant one before building a module (local only, `.opencode` is git-ignored).
- `.opencode/previous contexts/Liventra_Master_Context.md` — project handoff doc; its "CURRENT WORKING DECISIONS" outranks older SRS/model docs. Other files in that folder are historical ChatGPT exports.
- `api_documentation/{auth,farm,farmMember,breed,animal,feedIngredient,feedFormula}.md` — hand-written endpoint docs; keep the matching file in sync when routes change.
- `todos.md` — current dev todos (Bengali).
