import { MockData, loadMockData, saveMockData } from './services/mockData.js';
import { Handlers } from './services/mockHandlers.js';

/* tombstone: large mock backend implementations moved to services/mockData.js and services/mockHandlers.js */
/* removed helper: processCompletedCycles() {} */
/* removed functions: register(), login(), loginTelegram(), me(), checkIn(), getGpus(), getMarketGpus(), buyGpu(), getTransactions(), createTransaction(), createNotification(), getNotifications(), getAllUsers(), getAllTransactions(), updateTransactionStatus(), updateUser(), startCycle() {} */

loadMockData();

export const MockBackend = Handlers(MockData, { loadMockData, saveMockData });