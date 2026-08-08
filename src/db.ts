/**
 * Shared Prisma client for the process.
 * Bun loads DATABASE_URL from .env automatically.
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
export const prisma = new PrismaClient({ adapter })