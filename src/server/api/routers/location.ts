import { router, userProcedure, adminProcedure } from "@/server/trpc";
import { prisma } from "@/server/lib/prisma";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  locationGetInput,
  locationInput,
  locationUpdateInput,
} from "@/server/schema/location.schema";
import type { Prisma } from "@prisma/client";

async function collectDescendantIds(rootId: string): Promise<string[]> {
  const ids: string[] = [rootId];
  const children = await prisma.location.findMany({
    where: { parentId: rootId },
    select: { id: true },
  });
  for (const child of children) {
    ids.push(...(await collectDescendantIds(child.id)));
  }
  return ids;
}

export const locationRouter = router({
  create: adminProcedure.input(locationInput).mutation(async ({ input }) => {
    return prisma.location.create({
      data: input,
    });
  }),

  get: userProcedure
    .meta({
      mcp: {
        name: "location_get",
        enabled: true,
        description: "Get the information of a location by ID or name.",
      },
    })
    .input(locationGetInput)
    .query(async ({ input }) => {
      // Construct OR conditions without undefined
      const orConditions: Prisma.LocationWhereInput[] = [];
      if (input.id) {
        orConditions.push({ id: input.id });
      }
      if (input.name) {
        orConditions.push({ name: input.name });
      }

      return prisma.location.findFirst({
        where: {
          OR: orConditions.length > 0 ? orConditions : undefined,
        },
        include: {
          parent: true,
          children: true,
          items: true,
        },
      });
    }),
  // Get root locations.
  getRoots: userProcedure
    .meta({
      mcp: {
        name: "location_getRoots",
        enabled: true,
        description:
          "Get all root locations (top-level locations with no parent)",
      },
    })
    .query(async () => {
      return prisma.location.findMany({
        where: {
          parentId: null,
        },
        include: {
          parent: true,
          children: true,
          items: true,
        },
        orderBy: {
          name: "asc",
        },
      });
    }),

  getChildren: userProcedure
    .meta({
      mcp: {
        name: "location_getChildren",
        enabled: true,
        description: "Get all child locations under a given parent location ID",
      },
    })
    .input(z.object({ parentId: z.uuid() }))
    .query(async ({ input }) => {
      return prisma.location.findMany({
        where: {
          parentId: input.parentId,
        },
        include: {
          parent: true,
          children: true,
          items: true,
        },
        orderBy: {
          name: "asc",
        },
      });
    }),

  hasChildren: userProcedure
    .meta({
      mcp: {
        name: "location_hasChildren",
        enabled: true,
        description:
          "Check whether a location has any child locations. Returns true or false",
      },
    })
    .input(z.object({ locationId: z.uuid() }))
    .query(async ({ input }) => {
      const count = await prisma.location.count({
        where: {
          parentId: input.locationId,
        },
      });
      return count > 0;
    }),

  update: adminProcedure
    .input(z.object({ id: z.uuid(), data: locationUpdateInput }))
    .mutation(async ({ input }) => {
      return prisma.location.update({
        where: { id: input.id },
        data: input.data,
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ input }) => {
      const allIds = await collectDescendantIds(input.id);

      const itemCount = await prisma.item.count({
        where: { locationId: { in: allIds }, deleted: false },
      });

      if (itemCount > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot delete: ${itemCount} item${itemCount > 1 ? "s are" : " is"} still assigned to this location or its children. Move or delete them first.`,
        });
      }

      return prisma.$transaction(async (tx) => {
        await tx.location.updateMany({
          where: { id: { in: allIds } },
          data: { parentId: null },
        });
        await tx.location.deleteMany({
          where: { id: { in: allIds } },
        });
      });
    }),

  list: userProcedure
    .meta({
      mcp: {
        name: "location_list",
        enabled: true,
        description: "List all availible locations",
      },
    })
    .query(async () => {
      return prisma.location.findMany({
        include: {
          parent: true,
          children: true,
          items: true,
        },
      });
    }),
});
