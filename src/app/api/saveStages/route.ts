import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile } from "~/server/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

interface TemperatureStage {
  time: string;
  temp: number;
  name: string;
}

interface SaveStagesRequest {
  email: string;
  bedTime: string;
  wakeTime: string;
  side: string;
  stages: TemperatureStage[];
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = await request.json() as SaveStagesRequest;
    const { email, bedTime, wakeTime, stages } = body;

    if (!email || !bedTime || !wakeTime || !stages) {
      return Response.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Check if user profile exists
    const existingProfile = await db
      .select()
      .from(userTemperatureProfile)
      .where(eq(userTemperatureProfile.email, email))
      .limit(1);

    if (existingProfile.length === 0) {
      return Response.json(
        { success: false, error: "User profile not found. Please create a profile first through the main app." },
        { status: 404 }
      );
    }

    // Update the profile with custom stages
    await db
      .update(userTemperatureProfile)
      .set({
        bedTime: bedTime,
        wakeupTime: wakeTime,
        customStages: JSON.stringify(stages),
        updatedAt: new Date(),
      })
      .where(eq(userTemperatureProfile.email, email));

    return Response.json({
      success: true,
      message: "Temperature stages saved successfully!",
    });
  } catch (error) {
    console.error("Error saving stages:", error);
    return Response.json(
      { success: false, error: "Failed to save stages" },
      { status: 500 }
    );
  }
}
