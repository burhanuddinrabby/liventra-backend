import express, { type Application, type Request, type Response } from 'express';
const app: Application = express();
import cors from 'cors';
import cookieParser from 'cookie-parser';
import notFound from './app/middlewares/notFound.js';
import globalErrorHandler from './app/middlewares/globalErrorHandler.js';
import router from './app/routes/index.js';
import requestContext from './app/middlewares/requestContext.js';
import config from './app/config/index.js';
import { allowedOrigins } from './app/utils/clientOrigins.js';

app.set('trust proxy', config.trust_proxy);

//first, so every response (errors included) has a request id and CORS headers
app.use(requestContext);
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Content-Disposition']
}));

app.use(express.json());
app.use(cookieParser());

//all routes
app.use('/api/v1', router);

app.get('/', (req: Request, res: Response) => {
    res.send('Liventra backend api!\n');
});

app.all('{*splat}', notFound);

//global error handling
app.use(globalErrorHandler);

export default app;