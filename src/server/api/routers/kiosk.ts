import { router, publicProcedure } from "@/server/trpc";
import { prisma } from "@/server/lib/prisma";
import { getStudentInfo, postDiscordMessage } from "@/server/lib/external-api";
import { itemCheckout } from "../utils/item/item.checkout";
import { itemCheckin } from "../utils/item/item.checkin";
import { z } from "zod";
import { TRPCError } from "@trpc/server";

const AFTER_HOURS_DURATIONS = [
  "30 minutes",
  "1 hour",
  "1.5 hours",
  "2 hours",
  "3 hours",
  "4+ hours",
] as const;

const AFTER_HOURS_REASONS = [
  "Project work",
  "Study / Research",
  "Club activities",
  "Equipment maintenance",
  "Event setup",
  "Other",
] as const;

const DISCORD_AFTER_HOURS_CHANNEL =
  process.env.DISCORD_AFTER_HOURS_CHANNEL ?? "after-hours-log";

async function resolveUser(studentId: string) {
  const studentInfo = await getStudentInfo(studentId);
  const user = await prisma.user.findFirst({
    where: { email: studentInfo.email },
  });
  return { studentInfo, user };
}

export const kioskRouter = router({
  lookupStudent: publicProcedure
    .input(z.object({ studentId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { studentInfo, user } = await resolveUser(input.studentId);

      if (!user) {
        return {
          found: false as const,
          studentInfo,
          user: null,
        };
      }

      return {
        found: true as const,
        studentInfo,
        user: { id: user.id, name: user.name, email: user.email },
      };
    }),

  getSupervisors: publicProcedure.query(async () => {
    return prisma.user.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }),

  getAfterHoursOptions: publicProcedure.query(() => {
    return {
      durations: AFTER_HOURS_DURATIONS,
      reasons: AFTER_HOURS_REASONS,
    };
  }),

  logAfterHours: publicProcedure
    .input(
      z.object({
        studentId: z.string().min(1),
        duration: z.enum(AFTER_HOURS_DURATIONS),
        reason: z.enum(AFTER_HOURS_REASONS),
        supervisorId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { studentInfo, user } = await resolveUser(input.studentId);

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No account found for this student ID",
        });
      }

      let supervisorName = "None declared";
      if (input.supervisorId) {
        const supervisor = await prisma.user.findUnique({
          where: { id: input.supervisorId },
          select: { name: true },
        });
        if (supervisor) {
          supervisorName = supervisor.name;
        }
      }

      const timestamp = new Date().toLocaleString("en-AU", {
        timeZone: "Australia/Melbourne",
        dateStyle: "short",
        timeStyle: "short",
      });

      const text = [
        "🌙 **After Hours Access Log**",
        `👤 **Student:** ${studentInfo.name} (${studentInfo.email})`,
        `🕐 **Duration:** ${input.duration}`,
        `📋 **Reason:** ${input.reason}`,
        `👔 **Supervisor:** ${supervisorName}`,
        `📅 **Time:** ${timestamp}`,
      ].join("\n");

      await postDiscordMessage({
        channel: DISCORD_AFTER_HOURS_CHANNEL,
        text,
      });

      return { ok: true };
    }),

  getItemByQR: publicProcedure
    .input(z.object({ qrData: z.string() }))
    .mutation(async ({ input }) => {
      const segments = input.qrData.trim().split("/");
      const qrIndex = segments.indexOf("qr");
      const itemId =
        qrIndex !== -1
          ? (segments[qrIndex + 1] ?? "")
          : (segments[segments.length - 1] ?? "");

      if (!itemId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid QR code",
        });
      }

      const item = await prisma.item.findUnique({
        where: { id: itemId, deleted: false },
        select: {
          id: true,
          name: true,
          serial: true,
          consumable: { select: { available: true } },
          ItemRecords: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { loaned: true },
          },
        },
      });

      if (!item) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
      }

      return item;
    }),

  checkoutItems: publicProcedure
    .input(
      z.object({
        studentId: z.string().min(1),
        itemIds: z.array(z.string().uuid()).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { user } = await resolveUser(input.studentId);

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No account found for this student ID",
        });
      }

      const cart = input.itemIds.map((id) => ({ itemId: id, quantity: 1 }));
      const result = await itemCheckout(user.id, cart);
      return result;
    }),

  getUserLoanedItems: publicProcedure
    .input(z.object({ studentId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { user } = await resolveUser(input.studentId);

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No account found for this student ID",
        });
      }

      return prisma.itemRecord.findMany({
        where: {
          actionByUserId: user.id,
          loaned: true,
          item: { deleted: false },
        },
        orderBy: { createdAt: "desc" },
        distinct: ["itemId"],
        select: {
          id: true,
          itemId: true,
          createdAt: true,
          item: { select: { id: true, name: true, serial: true } },
        },
      });
    }),

  checkinItems: publicProcedure
    .input(
      z.object({
        studentId: z.string().min(1),
        itemIds: z.array(z.string().uuid()).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { user } = await resolveUser(input.studentId);

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No account found for this student ID",
        });
      }

      const cart = input.itemIds.map((id) => ({ itemId: id, quantity: 1 }));
      const result = await itemCheckin(user.id, cart);
      return result;
    }),
});
