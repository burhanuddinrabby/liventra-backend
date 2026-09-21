import express, { type Application, type Request, type Response } from 'express';
const app: Application = express();
import cors from 'cors';
import cookieParser from 'cookie-parser';
import notFound from './app/middlewares/notFound.js';
import globalErrorHandler from './app/middlewares/globalErrorHandler.js';
import router from './app/routes/index.js';

app.use(express.json());
app.use(cookieParser());

app.use(cors({ origin: ['http://localhost:5173', 'http://192.168.56.1:5173'], credentials: true }));

//all routes
app.use('/api/v1', router);

app.get('/', (req: Request, res: Response) => {
    res.send('Liventra backend api!\n');
});

app.all('{*splat}', notFound);

//global error handling
app.use(globalErrorHandler);

export default app;