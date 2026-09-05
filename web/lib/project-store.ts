import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, projectMembers, projects, todos } from "@/db/schema";

// Projects the employee belongs to, newest activity first.
export async function listMyProjects(employeeId: string) {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      ownerId: projects.ownerId,
      updatedAt: projects.updatedAt,
      memberCount: sql<number>`(select count(*) from ${projectMembers} pm where pm.project_id = ${projects.id})::int`,
      openTodos: sql<number>`(select count(*) from ${todos} t where t.project_id = ${projects.id} and t.done = false)::int`,
    })
    .from(projects)
    .innerJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.employeeId, employeeId),
      ),
    )
    .orderBy(desc(projects.updatedAt));
}

// Membership lookup for API routes: null = not a member.
export async function getMembership(projectId: string, employeeId: string) {
  const [m] = await db
    .select({ memberRole: projectMembers.memberRole })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.employeeId, employeeId),
      ),
    )
    .limit(1);
  return m ?? null;
}

// Full project view — returns null unless the employee is a member.
export async function getProject(projectId: string, employeeId: string) {
  const [membership] = await db
    .select({ memberRole: projectMembers.memberRole })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.employeeId, employeeId),
      ),
    )
    .limit(1);
  if (!membership) return null;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const members = await db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      memberRole: projectMembers.memberRole,
    })
    .from(projectMembers)
    .innerJoin(employees, eq(projectMembers.employeeId, employees.id))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(desc(projectMembers.memberRole), employees.name);

  const projectTodos = await db
    .select({
      id: todos.id,
      title: todos.title,
      due: todos.due,
      done: todos.done,
      createdAt: todos.createdAt,
      assigneeName: employees.name,
    })
    .from(todos)
    .innerJoin(employees, eq(todos.employeeId, employees.id))
    .where(eq(todos.projectId, projectId))
    .orderBy(todos.done, desc(todos.createdAt));

  return { project, members, todos: projectTodos, myRole: membership.memberRole };
}
