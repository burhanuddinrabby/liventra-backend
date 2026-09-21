import type { Server } from "http";
import app from "./app.js";
import config from "./app/config/index.js";
import AppError from "./app/errors/AppError.js";
import status from "http-status";
import mongoose from "mongoose";

let server: Server;

async function main() {
    const mongoUrl = config.db_url;
    if (!mongoUrl) {
        throw new AppError(status.NOT_FOUND, 'Mongodb url environment variable is not defined');
    }
    await mongoose.connect(mongoUrl);
    // seedSuperAdmin();
    server = app.listen(config.port, () => {
        console.log(`The app listening on port ${config.port}`);
    });
}
main().catch(err => console.log(err));

process.on('unhandledRejection', () => {
    console.log("UnhandledRejection detected!");
    if (server) {
        server.close(() => {
            process.exit(1);
        });
    }
    process.exit(1);
})

process.on('uncaughtException', () => {
    console.log("Uncaught Exception detected!");
    process.exit(1);
})