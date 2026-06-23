import { logger as rootLogger } from "./logger";
import { getTamarinService } from "./tamarin/service";

const logger = rootLogger.child({ module: "external-api" });

export interface StudentInfo {
  studentId: string;
  name: string;
  email: string;
  discordId: string;
}

export interface DiscordMessagePayload {
  channel: string;
  text: string;
}

export interface NotionProject {
  id: string;
  name: string;
}

export async function getStudentInfo(studentId: string): Promise<StudentInfo> {
  const tamarin = getTamarinService();

  if (!tamarin) {
    if (
      process.env.NODE_ENV !== "development" &&
      process.env.NODE_ENV !== "test"
    ) {
      throw new Error("Tamarin is not configured (missing env vars)");
    }
    return {
      studentId,
      name: "Test Student",
      email: "test@student.monash.edu",
      discordId: "000000000000000000",
    };
  }

  const member = await tamarin.getMember(studentId);
  return {
    studentId: member.student_number || studentId,
    name: member.name,
    email: member.email,
    discordId: member.discord_id,
  };
}

export async function getActiveProjects(): Promise<NotionProject[]> {
  const tamarin = getTamarinService();

  if (!tamarin) {
    return [
      { id: "proj-stub-1", name: "Example Project A" },
      { id: "proj-stub-2", name: "Example Project B" },
    ];
  }

  return tamarin.getProjects();
}

export async function postDiscordMessage(
  payload: DiscordMessagePayload,
): Promise<void> {
  const tamarin = getTamarinService();

  if (!tamarin) {
    if (
      process.env.NODE_ENV !== "development" &&
      process.env.NODE_ENV !== "test"
    ) {
      throw new Error("Tamarin is not configured (missing env vars)");
    }
    logger.debug(
      { channel: payload.channel, text: payload.text },
      "Discord stub",
    );
    return;
  }

  await tamarin.postAfterHours({ message: payload.text });
}
