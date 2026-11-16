"use strict";

const { PrismaClient } = require("@prisma/client");

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Development seeds cannot run in production");
  const userId = process.env.SEED_ADMIN_AUTH_USER_ID;
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  if (!userId || !email) throw new Error("Set SEED_ADMIN_AUTH_USER_ID and SEED_ADMIN_EMAIL to an existing Supabase Auth account");
  const prisma = new PrismaClient();
  try {
    const organization = await prisma.organization.upsert({
      where: { slug: "attendflow-development" },
      create: { name: "AttendFlow Development", slug: "attendflow-development", timezone: "UTC" },
      update: {},
      select: { id: true },
    });
    await prisma.employee.upsert({
      where: { supabaseUserId: userId },
      create: {
        organizationId: organization.id,
        supabaseUserId: userId,
        employeeNumber: "DEV-ADMIN",
        fullName: "Development Administrator",
        email,
        designation: "Administrator",
        role: "ADMINISTRATOR",
        status: "ACTIVE",
      },
      update: { organizationId: organization.id, role: "ADMINISTRATOR", status: "ACTIVE", deactivatedAt: null },
    });
    console.log(JSON.stringify({ status: "seeded", organizationId: organization.id, authUserId: userId }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error("Development seed failed", error.message); process.exitCode = 1; });
