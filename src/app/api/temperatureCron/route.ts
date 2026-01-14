import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import { setHeatingLevel, turnOnSide, turnOffSide } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";

export const runtime = "nodejs";

interface TemperatureStage {
  time: string;
  temp: number;
  name: string;
}

function createDateWithTime(baseDate: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  if (hours === undefined || minutes === undefined || isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time string: ${timeString}`);
  }
  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function isWithinTimeRange(current: Date, target: Date, rangeMinutes: number): boolean {
  const diffMs = Math.abs(current.getTime() - target.getTime());
  return diffMs <= rangeMinutes * 60 * 1000;
}

async function retryApiCall<T>(apiCall: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("This should never happen due to the for loop, but TypeScript doesn't know that");
}

function getCurrentTempForStages(
  bedTimeStr: string,
  wakeTimeStr: string,
  stages: TemperatureStage[],
  currentTime: Date
): number | null {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  const bedMinutes = timeToMinutes(bedTimeStr);
  const wakeMinutes = timeToMinutes(wakeTimeStr);
  
  let adjustedCurrent = currentMinutes;
  let adjustedWake = wakeMinutes;
  
  // Handle overnight schedules
  if (wakeMinutes < bedMinutes) {
    adjustedWake += 24 * 60;
  }
  
  if (currentMinutes < bedMinutes && currentMinutes < wakeMinutes) {
    adjustedCurrent += 24 * 60;
  }
  
  // Check if we're in the sleep schedule
  if (adjustedCurrent < bedMinutes || adjustedCurrent >= adjustedWake) {
    return null; // Outside sleep schedule
  }
  
  // Sort stages by time
  const sortedStages = [...stages].sort((a, b) => {
    let aMin = timeToMinutes(a.time);
    let bMin = timeToMinutes(b.time);
    
    if (aMin < bedMinutes) aMin += 24 * 60;
    if (bMin < bedMinutes) bMin += 24 * 60;
    
    return aMin - bMin;
  });
  
  // Find active temperature
  let activeTemp = sortedStages[0]?.temp ?? 0;
  
  for (const stage of sortedStages) {
    let stageMin = timeToMinutes(stage.time);
    if (stageMin < bedMinutes) stageMin += 24 * 60;
    
    if (adjustedCurrent >= stageMin) {
      activeTemp = stage.temp;
    } else {
      break;
    }
  }
  
  return activeTemp;
}

interface TestMode {
  enabled: boolean;
  currentTime: Date;
}

export async function adjustTemperature(testMode?: TestMode): Promise<void> {
  try {
    const profiles = await db
      .select()
      .from(userTemperatureProfile)
      .innerJoin(users, eq(userTemperatureProfile.email, users.email));

    for (const profile of profiles) {
      try {
        let token: Token = {
          eightAccessToken: profile.users.eightAccessToken,
          eightRefreshToken: profile.users.eightRefreshToken,
          eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
          eightUserId: profile.users.eightUserId,
        };

        const now = testMode?.enabled ? testMode.currentTime : new Date();

        if (!testMode?.enabled && now.getTime() > token.eightExpiresAtPosix) {
          token = await obtainFreshAccessToken(
            token.eightRefreshToken,
            token.eightUserId,
          );
          await db
            .update(users)
            .set({
              eightAccessToken: token.eightAccessToken,
              eightRefreshToken: token.eightRefreshToken,
              eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
            })
            .where(eq(users.email, profile.users.email));
        }

        const userProfile = profile.userTemperatureProfiles;
        const userNow = new Date(now.toLocaleString("en-US", { timeZone: userProfile.timezoneTZ }));

        // Parse custom stages if available, otherwise fall back to 3-stage system
        let stages: TemperatureStage[];
        if (userProfile.customStages && userProfile.customStages.trim() !== '') {
          try {
            stages = JSON.parse(userProfile.customStages) as TemperatureStage[];
          } catch (e) {
            console.log(`Failed to parse custom stages for ${profile.users.email}, falling back to 3-stage system`);
            // Fall back to 3-stage system
            stages = [
              { time: userProfile.bedTime, temp: userProfile.initialSleepLevel, name: 'Initial Sleep' },
              { time: addHoursToTime(userProfile.bedTime, 1), temp: userProfile.midStageSleepLevel, name: 'Mid Sleep' },
              { time: subtractHoursFromTime(userProfile.wakeupTime, 2), temp: userProfile.finalSleepLevel, name: 'Final Sleep' }
            ];
          }
        } else {
          // Use 3-stage system
          stages = [
            { time: userProfile.bedTime, temp: userProfile.initialSleepLevel, name: 'Initial Sleep' },
            { time: addHoursToTime(userProfile.bedTime, 1), temp: userProfile.midStageSleepLevel, name: 'Mid Sleep' },
            { time: subtractHoursFromTime(userProfile.wakeupTime, 2), temp: userProfile.finalSleepLevel, name: 'Final Sleep' }
          ];
        }

        const currentTemp = getCurrentTempForStages(
          userProfile.bedTime,
          userProfile.wakeupTime,
          stages,
          userNow
        );

        let heatingStatus;
        if (testMode?.enabled) {
          heatingStatus = { isHeating: false, heatingLevel: 0 };
          console.log(`[TEST MODE] Current time set to: ${userNow.toISOString()}`);
        } else {
          heatingStatus = await retryApiCall(() => getCurrentHeatingStatus(token));
        }

        console.log(`Current heating status for user ${profile.users.email}:`, JSON.stringify(heatingStatus));
        console.log(`User's current time: ${userNow.toISOString()} for user ${profile.users.email}`);
        console.log(`Active stages for user ${profile.users.email}:`, JSON.stringify(stages));

        if (currentTemp === null) {
          console.log(`User ${profile.users.email} is outside sleep schedule`);
          // Turn off heating if it's on and we're outside the schedule
          if (heatingStatus.isHeating) {
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would turn off heating for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
              console.log(`Heating turned off for user ${profile.users.email}`);
            }
          }
          continue;
        }

        console.log(`Target temperature for user ${profile.users.email}: ${currentTemp}`);

        // Turn on heating if needed
        if (!heatingStatus.isHeating) {
          if (testMode?.enabled) {
            console.log(`[TEST MODE] Would turn on heating for user ${profile.users.email}`);
          } else {
            await retryApiCall(() => turnOnSide(token, profile.users.eightUserId));
            console.log(`Heating turned on for user ${profile.users.email}`);
          }
        }

        // Set temperature if different
        if (heatingStatus.heatingLevel !== currentTemp) {
          if (testMode?.enabled) {
            console.log(`[TEST MODE] Would set heating level to ${currentTemp} for user ${profile.users.email}`);
          } else {
            await retryApiCall(() => setHeatingLevel(token, profile.users.eightUserId, currentTemp));
            console.log(`Heating level set to ${currentTemp} for user ${profile.users.email}`);
          }
        }

        console.log(`Successfully completed temperature adjustment check for user ${profile.users.email}`);
      } catch (error) {
        console.error(`Error adjusting temperature for user ${profile.users.email}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.error("Error fetching user profiles:", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function addHoursToTime(timeStr: string, hours: number): string {
  const [h, m] = timeStr.split(':').map(Number);
  const newHour = ((h ?? 0) + hours) % 24;
  return `${newHour.toString().padStart(2, '0')}:${(m ?? 0).toString().padStart(2, '0')}`;
}

function subtractHoursFromTime(timeStr: string, hours: number): string {
  const [h, m] = timeStr.split(':').map(Number);
  let newHour = (h ?? 0) - hours;
  if (newHour < 0) newHour += 24;
  return `${newHour.toString().padStart(2, '0')}:${(m ?? 0).toString().padStart(2, '0')}`;
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  } else {
    try {
      const testTimeParam = request.nextUrl.searchParams.get("testTime");
      if (testTimeParam) {
        const testTime = new Date(Number(testTimeParam) * 1000);
        if (isNaN(testTime.getTime())) {
          throw new Error("Invalid testTime parameter");
        }
        console.log(`[TEST MODE] Running temperature adjustment cron job with test time: ${testTime.toISOString()}`);
        await adjustTemperature({ enabled: true, currentTime: testTime });
      } else {
        await adjustTemperature();
      }
      return Response.json({ success: true });
    } catch (error) {
      console.error("Error in temperature adjustment cron job:", error instanceof Error ? error.message : String(error));
      return new Response("Internal server error", { status: 500 });
    }
  }
}
