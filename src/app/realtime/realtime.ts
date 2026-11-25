import type { Server as HttpServer } from "http";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import config from "../config/index.js";
import AppError from "../errors/AppError.js";
import { UserModel } from "../modules/auth/auth.model.js";
import { FarmMemberRoles } from "../modules/farmMember/farmMember.constants.js";
import { allowedOrigins } from "../utils/clientOrigins.js";
import { requireRole, resolveFarm } from "../utils/farmAccess.js";

type TId = { toString(): string };
// eslint-disable-next-line no-unused-vars
type TAck = (result: { ok: boolean; farmId?: string; message?: string }) => void;

const AUDIT_ROLES = [FarmMemberRoles.OWNER, FarmMemberRoles.MANAGER];
//setTimeout overflows above ~24.8 days
const MAX_TIMER_MS = 2_147_483_647;

let io: Server | null = null;

const userRoom = (userId: TId) => `user:${userId.toString()}`;
const auditRoom = (farmId: TId) => `farm:${farmId.toString()}:audit`;

/** Handshake errors carry a code only, never server details. */
const socketError = (code: "UNAUTHORIZED" | "UNAVAILABLE") =>
  Object.assign(new Error(code), { data: { code } });

const findActiveUser = (userId: string) =>
  UserModel.findOne({ userId, isActive: true, isDeleted: false }).select("_id userId").lean();

//access token from `auth.token` only: cookies and query strings are not accepted
// eslint-disable-next-line no-unused-vars
const authenticate = async (socket: Socket, next: (error?: Error) => void) => {
  let claims: JwtPayload;
  try {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== "string" || !token) throw new Error("missing token");
    claims = jwt.verify(token, config.jwt_access_token as string) as JwtPayload;
    if (typeof claims.userId !== "string") throw new Error("bad claims");
  } catch {
    next(socketError("UNAUTHORIZED"));
    return;
  }
  try {
    const user = await findActiveUser(claims.userId);
    if (!user) {
      next(socketError("UNAUTHORIZED"));
      return;
    }
    socket.data.userId = claims.userId;
    socket.data.userObjectId = user._id.toString();
    socket.data.exp = claims.exp;
    next();
  } catch {
    next(socketError("UNAVAILABLE"));
  }
};

const disconnectAtExpiry = (socket: Socket) => {
  const exp: unknown = socket.data.exp;
  if (typeof exp !== "number") return;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    const left = exp * 1000 - Date.now();
    if (left <= 0) {
      socket.disconnect(true);
      return;
    }
    timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
    timer.unref();
  };
  socket.on("disconnect", () => clearTimeout(timer));
  arm();
};

const readFarmId = (payload: unknown): string | undefined => {
  const farmId = (payload as { farmId?: unknown } | null | undefined)?.farmId;
  return typeof farmId === "string" && farmId && farmId.length <= 50 ? farmId : undefined;
};

const checkAuditAccess = async (farmId: string, userId: string) => {
  const access = await resolveFarm(farmId, userId);
  requireRole(access, AUDIT_ROLES);
  return access;
};

const subscribeAudit = async (socket: Socket, payload: unknown, ack: unknown) => {
  const reply: TAck = typeof ack === "function" ? (ack as TAck) : () => undefined;
  const farmId = readFarmId(payload);
  let room: string | undefined;
  try {
    if (!farmId) {
      reply({ ok: false, message: "farmId is required!" });
      return;
    }
    const { farm } = await checkAuditAccess(farmId, socket.data.userId);
    room = auditRoom(farm._id);
    await socket.join(room);
    //access may have been revoked between the check and the join
    await checkAuditAccess(farmId, socket.data.userId);
    reply({ ok: true, farmId: farm._id.toString() });
  } catch (error) {
    if (room) void socket.leave(room);
    reply({
      ok: false,
      message: error instanceof AppError ? error.message : "Could not subscribe, try again!",
    });
  }
};

const onConnection = async (socket: Socket) => {
  try {
    disconnectAtExpiry(socket);
    //listeners first: the client may send as soon as it is connected
    socket.on("audit.subscribe", (payload: unknown, ack: unknown) => {
      void subscribeAudit(socket, payload, ack);
    });
    socket.on("audit.unsubscribe", (payload: unknown) => {
      //the farm _id returned by audit.subscribe
      const farmId = readFarmId(payload);
      if (farmId) void socket.leave(auditRoom(farmId));
    });

    await socket.join(userRoom(socket.data.userObjectId));
    //the account may have been disabled between the handshake and the join
    if (!(await findActiveUser(socket.data.userId))) socket.disconnect(true);
  } catch (error) {
    console.log("[realtime] connection failed:", error);
    socket.disconnect(true);
  }
};

export const initRealtime = (server: HttpServer): void => {
  io = new Server(server, {
    cors: { origin: allowedOrigins },
    serveClient: false,
    maxHttpBufferSize: 10_000,
  });
  io.use((socket, next) => {
    void authenticate(socket, next);
  });
  io.on("connection", (socket) => {
    void onConnection(socket);
  });
};

//every helper below is best effort: realtime must never fail the business operation
// eslint-disable-next-line no-unused-vars
const safely = (work: (server: Server) => void): void => {
  if (!io) return;
  try {
    work(io);
  } catch (error) {
    console.log("[realtime] emit failed:", error);
  }
};

/** Call after commit only, with a small payload (ids, type, status). `userId` = User._id. */
export const emitToUser = (userId: TId, event: string, payload: object): void =>
  safely((server) => {
    server.to(userRoom(userId)).emit(event, payload);
  });

/** Call after commit only, with a small payload. `farmId` = Farm._id. */
export const emitToAuditRoom = (farmId: TId, event: string, payload: object): void =>
  safely((server) => {
    server.to(auditRoom(farmId)).emit(event, payload);
  });

/** Member removed, disabled or given another role: must subscribe (and be checked) again. */
export const removeUserFromFarm = (userId: TId, farmId: TId): void =>
  safely((server) => {
    server.in(userRoom(userId)).socketsLeave(auditRoom(farmId));
    server.to(userRoom(userId)).emit("audit.revoked", { farmId: farmId.toString() });
  });

/** Permanently deleted farm. */
export const closeFarmRooms = (farmId: TId): void =>
  safely((server) => server.socketsLeave(auditRoom(farmId)));

/** Account disabled, deleted, or its platform role changed. */
export const disconnectUser = (userId: TId): void =>
  safely((server) => server.in(userRoom(userId)).disconnectSockets(true));
