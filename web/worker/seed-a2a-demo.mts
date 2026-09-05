// Idempotent demo org for the A2A / transparent-ledger demo (feat/a2a-ledger).
// Re-runnable. Prints the login credentials at the end.
// Run: npx tsx --env-file=.env.local worker/seed-a2a-demo.mts
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { departments, employees, projectMembers, projects } from "../db/schema";

const PW = "demo-1234";

async function dept(name: string): Promise<string> {
  const [ex] = await db.select({ id: departments.id }).from(departments).where(eq(departments.name, name)).limit(1);
  if (ex) return ex.id;
  const [d] = await db.insert(departments).values({ name }).returning({ id: departments.id });
  return d.id;
}

async function emp(email: string, name: string, role: "employee" | "manager" | "admin", deptId: string): Promise<string> {
  const [ex] = await db.select({ id: employees.id }).from(employees).where(eq(employees.email, email)).limit(1);
  const passwordHash = await bcrypt.hash(PW, 10);
  if (ex) {
    await db.update(employees).set({ name, role, departmentId: deptId, passwordHash, mustChangePassword: false, active: true }).where(eq(employees.id, ex.id));
    return ex.id;
  }
  const [e] = await db.insert(employees).values({ email, name, role, departmentId: deptId, passwordHash, mustChangePassword: false }).returning({ id: employees.id });
  return e.id;
}

async function project(name: string, ownerId: string, memberIds: string[]): Promise<string> {
  const [ex] = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, name)).limit(1);
  const pid = ex?.id ?? (await db.insert(projects).values({ name, ownerId }).returning({ id: projects.id }))[0].id;
  for (const m of memberIds) {
    const [mem] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, pid), eq(projectMembers.employeeId, m))).limit(1);
    if (!mem) await db.insert(projectMembers).values({ projectId: pid, employeeId: m });
  }
  return pid;
}

const finance = await dept("財務部");
const sales = await dept("業務部");

const cfo = await emp("cfo@demo.local", "CFO 財務長", "manager", finance);
const ming = await emp("ming@demo.local", "小明 (財務)", "employee", finance);      // CFO's subordinate
const salesMgr = await emp("smgr@demo.local", "業務主管", "manager", sales);
const hua = await emp("hua@demo.local", "小華 (業務)", "employee", sales);

// Project A: sales team (smgr + hua) — intra-team queries allowed inside it.
await project("A 專案", salesMgr, [salesMgr, hua]);

console.log("\n=== A2A demo org seeded (idempotent) ===");
console.log("密碼一律:", PW, "(mustChangePassword=false)");
console.table([
  { email: "cfo@demo.local", name: "CFO 財務長", role: "manager", dept: "財務部", note: "小明的主管" },
  { email: "ming@demo.local", name: "小明 (財務)", role: "employee", dept: "財務部", note: "被查詢的當事人 → 看 /me/ledger" },
  { email: "smgr@demo.local", name: "業務主管", role: "manager", dept: "業務部", note: "跨部門查詢方" },
  { email: "hua@demo.local", name: "小華 (業務)", role: "employee", dept: "業務部", note: "A 專案成員" },
]);
console.log("\nDemo 流程:");
console.log("1. cfo 登入 → 對代理說『看小明的 A 專案進度』(scope=project) → 允許,寫帳本");
console.log("2. cfo 說『小明最近為什麼請假?』(scope=sensitive) → 交集拒絕,無 HITL 例外");
console.log("3. 換 ming 登入 → /me/ledger → 看到今天 1 允許 / 1 拒絕(含被拒絕的敏感查詢)= 世界首見畫面");
void cfo; void ming;
process.exit(0);
