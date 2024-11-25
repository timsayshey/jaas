import app from "./app.js";
import connectDB from "./config/db.js";
import { logger } from "./config/logger.js";

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });
});