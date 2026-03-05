import { PrismaClient } from "@prisma/client";
//import * as fs from "fs";

const prisma = new PrismaClient();

async function generateBambuConfig() {
  try {
    // 1. Fetch ONLY Bambu printers that have an auth token (access code)
    const dbPrinters = await prisma.printer.findMany({
      where: {
        type: "BAMBU",
        authToken: { not: null },
      },
    });

    // 2. Format them into the JSON structure
    const config = {
      listen: ":8080",
      printers: dbPrinters.map((printer) => ({
        name: printer.name,
        address: printer.ipAddress,
        access_code: printer.authToken,
      })),
    };

    // 3. Convert to JSON and save
    const jsonOutput = JSON.stringify(config, null, 2);
    //fs.writeFileSync("bambu-config.json", jsonOutput);
    
    //console.log("✅ Successfully generated bambu-config.json:");
    console.log(jsonOutput);

  } catch (error) {
    console.error("Failed to generate config:", error);
  } finally {
    await prisma.$disconnect();
  }
}

generateBambuConfig();
