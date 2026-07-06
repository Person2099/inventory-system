/**
 * External API — bearer-token authenticated REST endpoints for FYP integrations.
 *
 * Auth: All routes require `Authorization: Bearer <FYP_BEARER_TOKEN>`.
 *
 * Routes:
 *   POST   /api/ext/print/start                  — start a print job
 *   GET    /api/ext/printers/:printerId           — query printer + filament status
 *   POST   /api/ext/printers/:printerId/pause     — pause active print
 *   POST   /api/ext/printers/:printerId/stop      — stop active print
 *   GET    /api/ext/consumables                   — query consumable stock levels
 *   GET    /api/ext/assets                        — query asset availability
 *   POST   /api/ext/assets/checkout               — check out an asset
 *   POST   /api/ext/assets/checkin                — check in an asset
 *   GET    /api/ext/printers/:printerId/errors    — get Bambu HMS errors
 */

import { type Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "@/server/lib/prisma";
import { logger as rootLogger } from "@/server/lib/logger";
import {
    getBambuddyPrinterStatus,
    pauseBambuddyPrint,
    stopBambuddyPrint,
    addToQueue,
    uploadArchive,
    listQueue,
    resolveBambuddyPrinterId,
    type PrintQueueItemCreate,
} from "@/server/lib/bambuddy";
import { itemCheckout } from "@/server/api/utils/item/item.checkout";
import { itemCheckin } from "@/server/api/utils/item/item.checkin";
import { randomUUID } from "crypto";

const logger = rootLogger.child({ module: "external-api" });

// ─── Request logging helpers ──────────────────────────────────────────────────

function startRequest(req: Request): { requestId: string; start: number; ip: string } {
    const requestId = randomUUID();
    const start = Date.now();
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        ?? req.headers.get("x-real-ip")
        ?? "unknown";
    const url = new URL(req.url);
    logger.info(
        { requestId, method: req.method, path: url.pathname, ip },
        "ext-api request received",
    );
    return { requestId, start, ip };
}

function logSuccess(
    requestId: string,
    start: number,
    method: string,
    path: string,
    extra?: Record<string, unknown>,
): void {
    logger.info(
        { requestId, method, path, ms: Date.now() - start, status: 200, ...extra },
        "ext-api request completed",
    );
}

function logError(
    requestId: string,
    start: number,
    method: string,
    path: string,
    status: number,
    message: string,
    extra?: Record<string, unknown>,
): void {
    logger.warn(
        { requestId, method, path, ms: Date.now() - start, status, message, ...extra },
        "ext-api request failed",
    );
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireFypToken(req: Request, requestId: string): void {
    const expected = process.env.FYP_BEARER_TOKEN;
    if (!expected) {
        logger.error({ requestId }, "FYP_BEARER_TOKEN not configured");
        throw new HTTPException(503, {
            message: "External API not configured: FYP_BEARER_TOKEN missing",
        });
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const spaceIdx = authHeader.indexOf(" ");
    const scheme = spaceIdx === -1 ? authHeader : authHeader.slice(0, spaceIdx);
    const token = spaceIdx === -1 ? "" : authHeader.slice(spaceIdx + 1);
    if (scheme.toLowerCase() !== "bearer" || token !== expected) {
        logger.warn(
            {
                requestId,
                hasAuthHeader: authHeader.length > 0,
                scheme: scheme || "(none)",
            },
            "ext-api auth failed: invalid or missing bearer token",
        );
        throw new HTTPException(401, {
            message: "Invalid or missing bearer token",
        });
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveUserByStudentId(studentId: string) {
    const user = await prisma.user.findUnique({
        where: { studentNumber: studentId },
        select: { id: true, name: true, email: true, studentNumber: true },
    });
    if (!user) {
        throw new HTTPException(404, {
            message: `No user found with student ID: ${studentId}`,
        });
    }
    return user;
}

async function resolveBambuPrinterByLocalId(printerId: string): Promise<number> {
    // Accept a numeric BamBuddy printer ID directly
    const numericId = Number(printerId);
    if (Number.isInteger(numericId) && numericId > 0) {
        return numericId;
    }

    // Look up by local DB id, serial, or IP and resolve via BamBuddy
    const printer = await prisma.printer.findFirst({
        where: {
            OR: [
                { id: printerId },
                { serialNumber: printerId },
                { ipAddress: printerId },
            ],
        },
        select: { ipAddress: true, serialNumber: true, name: true },
    });
    if (!printer) {
        throw new HTTPException(404, {
            message: `Printer not found: ${printerId}`,
        });
    }

    const bambuId = await resolveBambuddyPrinterId({
        ipAddress: printer.ipAddress,
        serialNumber: printer.serialNumber,
    });
    if (!bambuId) {
        throw new HTTPException(404, {
            message: `Printer "${printer.name}" not found in BamBuddy`,
        });
    }
    return bambuId;
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountExternalApiRoutes(app: Hono): void {
    // ── POST /api/ext/print/start ─────────────────────────────────────────────
    // Start a print job by uploading a G-code file or specifying an archive ID.
    //
    // Body (multipart/form-data OR application/json):
    //   studentId      string   — student number of the requesting user
    //   gcodeFile      File?    — .3mf file to print (multipart only)
    //   archiveId      number?  — existing BamBuddy archive ID (JSON only)
    //   printerId      string?  — local printer ID / serial / IP (auto-assigns if omitted)
    //   filamentTypes  string[] — required filament types e.g. ["PLA","PETG"]
    //   project        string?  — Notion project name for record-keeping
    //
    // Success 200:
    //   { ok: true, queueItemId: number, status: string, position: number }
    //
    // Errors:
    //   400 — missing required fields or invalid file type
    //   401 — invalid/missing bearer token
    //   404 — studentId not found or printer not found
    //   502 — BamBuddy upstream error
    app.post("/api/ext/print/start", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const path = "/api/ext/print/start";
        requireFypToken(c.req.raw, requestId);

        const contentType = c.req.header("content-type") ?? "";
        let studentId: string;
        let archiveId: number | undefined;
        let printerId: string | undefined;
        let filamentTypes: string[] = [];
        let project: string | undefined;
        let gcodeFile: File | undefined;

        if (contentType.includes("multipart/form-data")) {
            const fd = await c.req.formData();
            studentId = (fd.get("studentId") as string | null) ?? "";
            const rawArchiveId = fd.get("archiveId");
            archiveId = rawArchiveId ? Number(rawArchiveId) : undefined;
            printerId = (fd.get("printerId") as string | null) ?? undefined;
            const rawFilament = fd.get("filamentTypes");
            filamentTypes = rawFilament
                ? (JSON.parse(rawFilament as string) as string[])
                : [];
            project = (fd.get("project") as string | null) ?? undefined;
            const maybeFile = fd.get("gcodeFile");
            if (maybeFile instanceof File) gcodeFile = maybeFile;
        } else {
            const body = await c.req.json<{
                studentId?: string;
                archiveId?: number;
                printerId?: string;
                filamentTypes?: string[];
                project?: string;
            }>();
            studentId = body.studentId ?? "";
            archiveId = body.archiveId != null ? Number(body.archiveId) : undefined;
            printerId = body.printerId;
            filamentTypes = Array.isArray(body.filamentTypes) ? body.filamentTypes : [];
            project = body.project;
        }

        logger.info(
            { requestId, studentId, archiveId, printerId, filamentTypes, project, hasFile: !!gcodeFile },
            "ext-api print/start params",
        );

        if (!studentId) {
            logError(requestId, start, "POST", path, 400, "studentId is required");
            throw new HTTPException(400, { message: "studentId is required" });
        }
        if (!archiveId && !gcodeFile) {
            logError(requestId, start, "POST", path, 400, "archiveId or gcodeFile required");
            throw new HTTPException(400, {
                message: "Either archiveId or gcodeFile must be provided",
            });
        }

        const user = await resolveUserByStudentId(studentId);
        logger.debug({ requestId, userId: user.id, studentId }, "ext-api resolved user");

        // Upload 3MF file if provided
        if (gcodeFile && !archiveId) {
            if (!gcodeFile.name.toLowerCase().endsWith(".3mf")) {
                logError(requestId, start, "POST", path, 400, "invalid file type", { filename: gcodeFile.name });
                throw new HTTPException(400, {
                    message: "Only .3mf files are accepted",
                });
            }
            logger.info({ requestId, filename: gcodeFile.name, bytes: gcodeFile.size }, "ext-api uploading 3MF to BamBuddy");
            const bytes = await gcodeFile.arrayBuffer();
            try {
                archiveId = await uploadArchive(gcodeFile.name, Buffer.from(bytes));
                logger.info({ requestId, archiveId }, "ext-api 3MF uploaded to BamBuddy");
            } catch (err) {
                logger.error({ requestId, err }, "ext-api failed to upload 3MF to BamBuddy");
                logError(requestId, start, "POST", path, 502, "BamBuddy upload failed");
                throw new HTTPException(502, {
                    message: `BamBuddy upload failed: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        }

        // Resolve BamBuddy printer_id if specified
        let bambuPrinterId: number | undefined;
        if (printerId) {
            logger.debug({ requestId, printerId }, "ext-api resolving printer");
            bambuPrinterId = await resolveBambuPrinterByLocalId(printerId);
            logger.debug({ requestId, printerId, bambuPrinterId }, "ext-api printer resolved");
        }

        const payload: PrintQueueItemCreate = {
            archive_id: archiveId,
            printer_id: bambuPrinterId ?? null,
            required_filament_types: filamentTypes.length ? filamentTypes : null,
        };

        logger.info({ requestId, payload }, "ext-api submitting to BamBuddy queue");
        let queueItem: Awaited<ReturnType<typeof addToQueue>>;
        try {
            queueItem = await addToQueue(payload);
        } catch (err) {
            logger.error({ requestId, err }, "ext-api BamBuddy addToQueue failed");
            logError(requestId, start, "POST", path, 502, "Failed to add to print queue");
            throw new HTTPException(502, {
                message: `Failed to add to print queue: ${err instanceof Error ? err.message : String(err)}`,
            });
        }

        // Record the submission in local DB — mirrors what the tRPC addToQueue mutation stores
        await prisma.printQueueSubmission.create({
            data: {
                bambuddyQueueItemId: queueItem.id,
                bambuddyQueueCreatedAt: queueItem.created_at
                    ? new Date(queueItem.created_at)
                    : null,
                archiveId: archiveId ?? null,
                archiveName: queueItem.archive_name ?? gcodeFile?.name ?? null,
                userId: user.id,
                notionProjectName: project ?? null,
                personalUse: false,
            },
        });

        logSuccess(requestId, start, "POST", path, {
            queueItemId: queueItem.id,
            queueStatus: queueItem.status,
            studentId,
            userId: user.id,
        });
        return c.json({
            ok: true,
            queueItemId: queueItem.id,
            status: queueItem.status,
            position: queueItem.position,
            printerName: queueItem.printer_name ?? null,
        });
    });

    // ── GET /api/ext/printers/:printerId ──────────────────────────────────────
    // Query live printer and filament status via BamBuddy.
    //
    // Params:
    //   printerId — local printer DB id, serial number, or IP address
    //
    // Success 200:
    //   {
    //     ok: true,
    //     printer: { id, name, state, connected },
    //     currentPrint: { gcodeFile, progress, remainingTimeSeconds, estimatedPrintTimeSeconds } | null,
    //     filament: { ams: AMSUnit[], vtTray: AMSTray[] },
    //     hmsErrors: HMSError[]
    //   }
    //
    // Errors:
    //   401 — invalid/missing bearer token
    //   404 — printer not found
    //   502 — BamBuddy upstream error
    app.get("/api/ext/printers/:printerId", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const rawPrinterId = c.req.param("printerId");
        const path = `/api/ext/printers/${rawPrinterId}`;
        requireFypToken(c.req.raw, requestId);

        logger.debug({ requestId, rawPrinterId }, "ext-api resolving printer");
        const bambuId = await resolveBambuPrinterByLocalId(rawPrinterId);
        logger.debug({ requestId, rawPrinterId, bambuId }, "ext-api printer resolved");

        let status: Awaited<ReturnType<typeof getBambuddyPrinterStatus>>;
        try {
            logger.info({ requestId, bambuId }, "ext-api fetching printer status from BamBuddy");
            status = await getBambuddyPrinterStatus(bambuId);
        } catch (err) {
            logger.error({ requestId, bambuId, err }, "ext-api BamBuddy printer status fetch failed");
            logError(requestId, start, "GET", path, 502, "Failed to fetch printer status");
            throw new HTTPException(502, {
                message: `Failed to fetch printer status: ${err instanceof Error ? err.message : String(err)}`,
            });
        }

        // Look up who is currently printing via the BamBuddy queue
        let currentUser: { name: string; studentNumber: string | null } | null = null;
        if (status.current_print) {
            try {
                const activeItems = await listQueue({ printerId: bambuId, status: "printing" });
                const activeItem = activeItems[0];
                if (activeItem) {
                    const submission = await prisma.printQueueSubmission.findUnique({
                        where: { bambuddyQueueItemId: activeItem.id },
                        select: { user: { select: { name: true, studentNumber: true } } },
                    });
                    currentUser = submission?.user ?? null;
                }
            } catch (err) {
                // Non-critical — printer status still returned without user info
                logger.warn({ requestId, bambuId, err }, "ext-api failed to resolve current print user (non-fatal)");
            }
        }

        logSuccess(requestId, start, "GET", path, {
            bambuId,
            printerState: status.state,
            connected: status.connected,
            hasPrint: !!status.current_print,
        });
        return c.json({
            ok: true,
            printer: {
                id: status.id,
                name: status.name,
                state: status.state,
                connected: status.connected,
            },
            currentPrint: status.current_print
                ? {
                      gcodeFile: status.gcode_file,
                      progress: status.progress,
                      remainingTimeSeconds: status.remaining_time,
                      printedBy: currentUser,
                  }
                : null,
            filament: {
                ams: status.ams,
                vtTray: status.vt_tray,
            },
            hmsErrors: status.hms_errors,
        });
    });

    // ── POST /api/ext/printers/:printerId/pause ───────────────────────────────
    // Pause the active print on a printer.
    //
    // Params:
    //   printerId — local printer DB id, serial, or IP
    //
    // Body (JSON):
    //   studentId  string — student number of the requestor (logged only)
    //
    // Success 200: { ok: true, action: "paused", printerId: number }
    // Errors: 400, 401, 404, 502
    app.post("/api/ext/printers/:printerId/pause", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const rawPrinterId = c.req.param("printerId");
        const path = `/api/ext/printers/${rawPrinterId}/pause`;
        requireFypToken(c.req.raw, requestId);

        const body = await c.req.json<{ studentId?: string }>();
        const studentId = body.studentId;
        if (!studentId) {
            logError(requestId, start, "POST", path, 400, "studentId is required");
            throw new HTTPException(400, { message: "studentId is required" });
        }

        await resolveUserByStudentId(studentId);
        const bambuId = await resolveBambuPrinterByLocalId(rawPrinterId);
        logger.info({ requestId, bambuId, studentId }, "ext-api pausing print");

        try {
            await pauseBambuddyPrint(bambuId);
        } catch (err) {
            logger.error({ requestId, bambuId, studentId, err }, "ext-api BamBuddy pause failed");
            logError(requestId, start, "POST", path, 502, "Failed to pause print");
            throw new HTTPException(502, {
                message: `Failed to pause print: ${err instanceof Error ? err.message : String(err)}`,
            });
        }

        logSuccess(requestId, start, "POST", path, { bambuId, studentId });
        return c.json({ ok: true, action: "paused", printerId: bambuId });
    });

    // ── POST /api/ext/printers/:printerId/stop ────────────────────────────────
    // Stop the active print on a printer.
    //
    // Params:
    //   printerId — local printer DB id, serial, or IP
    //
    // Body (JSON):
    //   studentId  string — student number of the requestor (logged only)
    //
    // Success 200: { ok: true, action: "stopped", printerId: number }
    // Errors: 400, 401, 404, 502
    app.post("/api/ext/printers/:printerId/stop", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const rawPrinterId = c.req.param("printerId");
        const path = `/api/ext/printers/${rawPrinterId}/stop`;
        requireFypToken(c.req.raw, requestId);

        const body = await c.req.json<{ studentId?: string }>();
        const studentId = body.studentId;
        if (!studentId) {
            logError(requestId, start, "POST", path, 400, "studentId is required");
            throw new HTTPException(400, { message: "studentId is required" });
        }

        await resolveUserByStudentId(studentId);
        const bambuId = await resolveBambuPrinterByLocalId(rawPrinterId);
        logger.info({ requestId, bambuId, studentId }, "ext-api stopping print");

        try {
            await stopBambuddyPrint(bambuId);
        } catch (err) {
            logger.error({ requestId, bambuId, studentId, err }, "ext-api BamBuddy stop failed");
            logError(requestId, start, "POST", path, 502, "Failed to stop print");
            throw new HTTPException(502, {
                message: `Failed to stop print: ${err instanceof Error ? err.message : String(err)}`,
            });
        }

        logSuccess(requestId, start, "POST", path, { bambuId, studentId });
        return c.json({ ok: true, action: "stopped", printerId: bambuId });
    });

    // ── GET /api/ext/consumables ──────────────────────────────────────────────
    // Query stock levels for consumables.
    //
    // Query params:
    //   type   string? — filter by item name (partial, case-insensitive)
    //
    // Success 200:
    //   { ok: true, consumables: [{ name, available, total, minStock }] }
    //
    // Errors: 401
    app.get("/api/ext/consumables", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const path = "/api/ext/consumables";
        requireFypToken(c.req.raw, requestId);
        const typeFilter = c.req.query("type");
        logger.debug({ requestId, typeFilter }, "ext-api querying consumables");

        const consumables = await prisma.consumable.findMany({
            where: typeFilter
                ? { item: { name: { contains: typeFilter, mode: "insensitive" }, deleted: false } }
                : { item: { deleted: false } },
            select: {
                available: true,
                total: true,
                minStock: true,
                item: { select: { name: true } },
            },
            orderBy: { item: { name: "asc" } },
        });

        logSuccess(requestId, start, "GET", path, { resultCount: consumables.length, typeFilter });
        return c.json({
            ok: true,
            consumables: consumables.map((c) => ({
                name: c.item?.name ?? "Unknown",
                available: c.available,
                total: c.total,
                minStock: c.minStock,
                lowStock: c.available <= c.minStock,
            })),
        });
    });

    // ── GET /api/ext/assets ───────────────────────────────────────────────────
    // Query availability of non-consumable assets.
    //
    // Query params:
    //   type   string? — filter by item name (partial, case-insensitive)
    //
    // Success 200:
    //   {
    //     ok: true,
    //     assets: [{
    //       name, serial, status: "in_storage" | "checked_out",
    //       storageLocation, availableCount, totalCount
    //     }]
    //   }
    //
    // Errors: 401
    app.get("/api/ext/assets", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const path = "/api/ext/assets";
        requireFypToken(c.req.raw, requestId);
        const typeFilter = c.req.query("type");
        logger.debug({ requestId, typeFilter }, "ext-api querying assets");

        const items = await prisma.item.findMany({
            where: {
                deleted: false,
                consumable: null,
                ...(typeFilter
                    ? { name: { contains: typeFilter, mode: "insensitive" } }
                    : {}),
            },
            select: {
                id: true,
                name: true,
                serial: true,
                location: { select: { name: true } },
                ItemRecords: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: { loaned: true },
                },
            },
            orderBy: [{ name: "asc" }, { serial: "asc" }],
        });

        // Group by name for summary counts
        const byName = new Map<
            string,
            { total: number; available: number; location: string }
        >();
        for (const item of items) {
            const isLoaned = item.ItemRecords[0]?.loaned === true;
            const entry = byName.get(item.name) ?? {
                total: 0,
                available: 0,
                location: item.location?.name ?? "Unknown",
            };
            entry.total += 1;
            if (!isLoaned) entry.available += 1;
            byName.set(item.name, entry);
        }

        logSuccess(requestId, start, "GET", path, { resultCount: items.length, typeFilter });
        return c.json({
            ok: true,
            assets: items.map((item) => ({
                name: item.name,
                serial: item.serial,
                status: item.ItemRecords[0]?.loaned === true ? "checked_out" : "in_storage",
                storageLocation: item.location?.name ?? null,
                availableCount: byName.get(item.name)?.available ?? 0,
                totalCount: byName.get(item.name)?.total ?? 0,
            })),
        });
    });

    // ── POST /api/ext/assets/checkout ─────────────────────────────────────────
    // Check out an asset to a student.
    //
    // Body (JSON):
    //   studentId  string — student number
    //   serial     string — asset serial number
    //
    // Success 200: { ok: true, serial, name, checkedOutTo: { name, studentNumber } }
    // Errors: 400, 401, 404, 409 (already checked out)
    app.post("/api/ext/assets/checkout", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const path = "/api/ext/assets/checkout";
        requireFypToken(c.req.raw, requestId);

        const body = await c.req.json<{ studentId?: string; serial?: string }>();
        const studentId = body.studentId;
        const serial = body.serial;

        if (!studentId) {
            logError(requestId, start, "POST", path, 400, "studentId is required");
            throw new HTTPException(400, { message: "studentId is required" });
        }
        if (!serial) {
            logError(requestId, start, "POST", path, 400, "serial is required");
            throw new HTTPException(400, { message: "serial is required" });
        }

        logger.debug({ requestId, studentId, serial }, "ext-api checkout params");
        const user = await resolveUserByStudentId(studentId);

        const item = await prisma.item.findUnique({
            where: { serial, deleted: false },
            select: { id: true, name: true, consumable: true },
        });
        if (!item) {
            logError(requestId, start, "POST", path, 404, `Asset not found: ${serial}`, { serial });
            throw new HTTPException(404, { message: `Asset not found: ${serial}` });
        }
        if (item.consumable) {
            logError(requestId, start, "POST", path, 400, "consumable item via assets endpoint", { serial });
            throw new HTTPException(400, {
                message: "Use the consumable endpoint for consumable items",
            });
        }

        logger.info({ requestId, serial, itemId: item.id, userId: user.id, studentId }, "ext-api checking out asset");
        const result = await itemCheckout(
            user.id,
            [{ itemId: item.id, quantity: 1 }],
            undefined,
            "Via External API",
        );

        if (!result.ok) {
            logger.error({ requestId, serial, itemId: item.id, userId: user.id, failures: result.failures }, "ext-api checkout failed");
            logError(requestId, start, "POST", path, 422, "Checkout failed");
            throw new HTTPException(422, {
                message: `Checkout failed: ${typeof result.failures === "string" ? result.failures : JSON.stringify(result.failures)}`,
            });
        }

        logSuccess(requestId, start, "POST", path, { serial, itemId: item.id, userId: user.id, studentId });
        return c.json({
            ok: true,
            serial,
            name: item.name,
            checkedOutTo: { name: user.name, studentNumber: user.studentNumber },
        });
    });

    // ── POST /api/ext/assets/checkin ──────────────────────────────────────────
    // Check in an asset from a student.
    //
    // Body (JSON):
    //   studentId  string — student number
    //   serial     string — asset serial number
    //
    // Success 200: { ok: true, serial, name, checkedInBy: { name, studentNumber } }
    // Errors: 400, 401, 404, 409 (already in storage)
    app.post("/api/ext/assets/checkin", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const path = "/api/ext/assets/checkin";
        requireFypToken(c.req.raw, requestId);

        const body = await c.req.json<{ studentId?: string; serial?: string }>();
        const studentId = body.studentId;
        const serial = body.serial;

        if (!studentId) {
            logError(requestId, start, "POST", path, 400, "studentId is required");
            throw new HTTPException(400, { message: "studentId is required" });
        }
        if (!serial) {
            logError(requestId, start, "POST", path, 400, "serial is required");
            throw new HTTPException(400, { message: "serial is required" });
        }

        logger.debug({ requestId, studentId, serial }, "ext-api checkin params");
        const user = await resolveUserByStudentId(studentId);

        const item = await prisma.item.findUnique({
            where: { serial, deleted: false },
            select: { id: true, name: true, consumable: true },
        });
        if (!item) {
            logError(requestId, start, "POST", path, 404, `Asset not found: ${serial}`, { serial });
            throw new HTTPException(404, { message: `Asset not found: ${serial}` });
        }
        if (item.consumable) {
            logError(requestId, start, "POST", path, 400, "consumable cannot be returned", { serial });
            throw new HTTPException(400, {
                message: "Consumables cannot be returned",
            });
        }

        logger.info({ requestId, serial, itemId: item.id, userId: user.id, studentId }, "ext-api checking in asset");
        const result = await itemCheckin(
            user.id,
            [{ itemId: item.id, quantity: 1 }],
            undefined,
            "Via External API",
        );

        if (!result.ok) {
            logger.error({ requestId, serial, itemId: item.id, userId: user.id, failures: result.failures }, "ext-api checkin failed");
            logError(requestId, start, "POST", path, 422, "Checkin failed");
            throw new HTTPException(422, {
                message: `Checkin failed: ${typeof result.failures === "string" ? result.failures : JSON.stringify(result.failures)}`,
            });
        }

        logSuccess(requestId, start, "POST", path, { serial, itemId: item.id, userId: user.id, studentId });
        return c.json({
            ok: true,
            serial,
            name: item.name,
            checkedInBy: { name: user.name, studentNumber: user.studentNumber },
        });
    });

    // ── GET /api/ext/printers/:printerId/errors ───────────────────────────────
    // Fetch active Bambu HMS errors for a printer.
    //
    // Params:
    //   printerId — local printer DB id, serial, or IP
    //
    // Success 200:
    //   { ok: true, printerId: number, hmsErrors: [{ code, attr, module, severity }] }
    //
    // Errors: 401, 404, 502
    app.get("/api/ext/printers/:printerId/errors", async (c) => {
        const { requestId, start } = startRequest(c.req.raw);
        const rawPrinterId = c.req.param("printerId");
        const path = `/api/ext/printers/${rawPrinterId}/errors`;
        requireFypToken(c.req.raw, requestId);

        logger.debug({ requestId, rawPrinterId }, "ext-api resolving printer for errors");
        const bambuId = await resolveBambuPrinterByLocalId(rawPrinterId);

        let status: Awaited<ReturnType<typeof getBambuddyPrinterStatus>>;
        try {
            logger.info({ requestId, bambuId }, "ext-api fetching printer status for errors");
            status = await getBambuddyPrinterStatus(bambuId);
        } catch (err) {
            logger.error({ requestId, bambuId, err }, "ext-api BamBuddy status fetch failed (errors endpoint)");
            logError(requestId, start, "GET", path, 502, "Failed to fetch printer status");
            throw new HTTPException(502, {
                message: `Failed to fetch printer status: ${err instanceof Error ? err.message : String(err)}`,
            });
        }

        logSuccess(requestId, start, "GET", path, { bambuId, errorCount: status.hms_errors?.length ?? 0 });
        return c.json({
            ok: true,
            printerId: bambuId,
            printerName: status.name,
            hmsErrors: status.hms_errors,
        });
    });
}
