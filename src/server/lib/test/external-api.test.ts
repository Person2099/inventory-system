import { describe, it, vi, expect, afterEach, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { getStudentInfo, postDiscordMessage } from "@/server/lib/external-api";
import { resetTamarinService } from "@/server/lib/tamarin/service";

const TAMARIN_VARS = {
  NOTION_TOKEN: "test-notion-token",
  MEMBERS_DB_ID: "members-db-id",
  PROJECTS_DB_ID: "projects-db-id",
  AFTER_HOURS_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/test",
  AFTER_HOURS_GUILD_ID: "guild-id",
  AFTER_HOURS_BOT_TOKEN: "bot-token",
};

function setTamarinEnv() {
  for (const [k, v] of Object.entries(TAMARIN_VARS)) {
    process.env[k] = v;
  }
}

function clearTamarinEnv() {
  for (const k of Object.keys(TAMARIN_VARS)) {
    delete process.env[k];
  }
}

function notionMemberResponse(member: {
  id: string;
  name: string;
  student_number: string;
  email: string;
  discord_id: string;
}) {
  return {
    ok: true,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          results: [
            {
              id: member.id,
              properties: {
                Name: { title: [{ plain_text: member.name }] },
                "Student ID": {
                  rich_text: [{ plain_text: member.student_number }],
                },
                "Monash Email": { email: member.email },
                Discord: { rich_text: [{ plain_text: member.discord_id }] },
              },
            },
          ],
        }),
      ),
  };
}

beforeEach(() => {
  clearTamarinEnv();
  resetTamarinService();
});

afterEach(() => {
  vi.clearAllMocks();
  clearTamarinEnv();
  resetTamarinService();
});

describe("getStudentInfo", () => {
  describe("stub mode (tamarin not configured)", () => {
    it("returns mock data with provided studentId", async () => {
      const result = await getStudentInfo("12345678");

      expect(result.studentId).toBe("12345678");
      expect(result.name).toBeDefined();
      expect(result.email).toBeDefined();
      expect(result.discordId).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves studentId in returned stub data", async () => {
      const result = await getStudentInfo("99887766");
      expect(result.studentId).toBe("99887766");
    });
  });

  describe("real mode (tamarin configured)", () => {
    it("calls Notion and maps member fields", async () => {
      setTamarinEnv();

      fetchMock.mockResolvedValueOnce(
        notionMemberResponse({
          id: "page-id",
          name: "Jane Smith",
          student_number: "12345678",
          email: "jane@student.monash.edu",
          discord_id: "111222333",
        }),
      );

      const result = await getStudentInfo("12345678");

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("notion.com/v1/databases/members-db-id/query"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-notion-token",
          }),
        }),
      );
      expect(result.studentId).toBe("12345678");
      expect(result.name).toBe("Jane Smith");
      expect(result.email).toBe("jane@student.monash.edu");
      expect(result.discordId).toBe("111222333");
    });

    it("throws MEMBER_NOT_FOUND when Notion returns no results", async () => {
      setTamarinEnv();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ results: [] })),
      });

      await expect(getStudentInfo("00000000")).rejects.toThrow(
        "Member not found",
      );
    });
  });
});

describe("postDiscordMessage", () => {
  describe("stub mode (tamarin not configured)", () => {
    it("skips API call in stub mode", async () => {
      await postDiscordMessage({ channel: "test-channel", text: "hello" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resolves without error", async () => {
      await expect(
        postDiscordMessage({ channel: "any", text: "any" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("real mode (tamarin configured)", () => {
    it("POSTs to Discord webhook with message text", async () => {
      setTamarinEnv();

      fetchMock.mockResolvedValueOnce({ ok: true });

      await postDiscordMessage({
        channel: "after-hours",
        text: "test message",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/test",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            content: "test message",
            allowed_mentions: { parse: ["users", "roles"] },
          }),
        }),
      );
    });

    it("throws on non-OK webhook response", async () => {
      setTamarinEnv();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      await expect(
        postDiscordMessage({ channel: "ch", text: "txt" }),
      ).rejects.toThrow("Discord webhook returned 500");
    });
  });
});
