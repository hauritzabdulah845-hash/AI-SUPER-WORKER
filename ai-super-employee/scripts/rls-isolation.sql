-- ============================================================
-- AI 超级员工 · 多租户数据隔离（RLS）
--
-- 目标：每个账号只能看到 / 修改自己的数据。
--       官方模板是公共资产，所有账号可读。
--
-- 执行方式：云服务数据库面板，或 MCP 的 exec_sql（mode=migrate）。
-- 注意：PostgreSQL 一次只能执行一条语句，下面每句都单独执行。
--       本脚本幂等，可重复运行。
--
-- 为什么两层都要做：
--   应用层过滤（src/cloud/api.ts）只防串号，防不住有人拿公开密钥直接调接口；
--   只有 RLS 让「越权读取」在数据库层面直接失败，才算真正隔离。
-- ============================================================


-- ---------- 1. 让归属自动落到当前登录账号（服务端决定，客户端伪造无效）----------
-- 逐表执行：
ALTER TABLE public.tasks ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.task_steps ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.leads ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.knowledge_docs ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.agents ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.wecom_links ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.messages ALTER COLUMN owner_id SET DEFAULT auth.uid();


-- ---------- 2. 打开行级安全 ----------
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wecom_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_templates ENABLE ROW LEVEL SECURITY;


-- ---------- 3. 表级授权（RLS 前必须先 GRANT，否则报 42501 看起来像策略失效）----------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tasks TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.task_steps TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.leads TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_docs TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agents TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.wecom_links TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_templates TO authenticated, anon;


-- ---------- 4. 私有表策略：只能碰自己的行 ----------
-- 4.1 tasks
DROP POLICY IF EXISTS tasks_select_own ON public.tasks;
CREATE POLICY tasks_select_own ON public.tasks FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
DROP POLICY IF EXISTS tasks_insert_own ON public.tasks;
CREATE POLICY tasks_insert_own ON public.tasks FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS tasks_update_own ON public.tasks;
CREATE POLICY tasks_update_own ON public.tasks FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS tasks_delete_own ON public.tasks;
CREATE POLICY tasks_delete_own ON public.tasks FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

-- 4.2 task_steps
DROP POLICY IF EXISTS task_steps_select_own ON public.task_steps;
CREATE POLICY task_steps_select_own ON public.task_steps FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
DROP POLICY IF EXISTS task_steps_insert_own ON public.task_steps;
CREATE POLICY task_steps_insert_own ON public.task_steps FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS task_steps_update_own ON public.task_steps;
CREATE POLICY task_steps_update_own ON public.task_steps FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS task_steps_delete_own ON public.task_steps;
CREATE POLICY task_steps_delete_own ON public.task_steps FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

-- 4.3 leads
DROP POLICY IF EXISTS leads_select_own ON public.leads;
CREATE POLICY leads_select_own ON public.leads FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
DROP POLICY IF EXISTS leads_insert_own ON public.leads;
CREATE POLICY leads_insert_own ON public.leads FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS leads_update_own ON public.leads;
CREATE POLICY leads_update_own ON public.leads FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS leads_delete_own ON public.leads;
CREATE POLICY leads_delete_own ON public.leads FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

-- 4.4 knowledge_docs
DROP POLICY IF EXISTS knowledge_select_own ON public.knowledge_docs;
CREATE POLICY knowledge_select_own ON public.knowledge_docs FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
DROP POLICY IF EXISTS knowledge_insert_own ON public.knowledge_docs;
CREATE POLICY knowledge_insert_own ON public.knowledge_docs FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS knowledge_update_own ON public.knowledge_docs;
CREATE POLICY knowledge_update_own ON public.knowledge_docs FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS knowledge_delete_own ON public.knowledge_docs;
CREATE POLICY knowledge_delete_own ON public.knowledge_docs FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

-- 4.5 agents
DROP POLICY IF EXISTS agents_select_own ON public.agents;
CREATE POLICY agents_select_own ON public.agents FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
DROP POLICY IF EXISTS agents_insert_own ON public.agents;
CREATE POLICY agents_insert_own ON public.agents FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS agents_update_own ON public.agents;
CREATE POLICY agents_update_own ON public.agents FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS agents_delete_own ON public.agents;
CREATE POLICY agents_delete_own ON public.agents FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

-- 4.6 wecom_links
DROP POLICY IF EXISTS wecom_select_own ON public.wecom_links;
CREATE POLICY wecom_select_own ON public.wecom_links FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
DROP POLICY IF EXISTS wecom_insert_own ON public.wecom_links;
CREATE POLICY wecom_insert_own ON public.wecom_links FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS wecom_update_own ON public.wecom_links;
CREATE POLICY wecom_update_own ON public.wecom_links FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS wecom_delete_own ON public.wecom_links;
CREATE POLICY wecom_delete_own ON public.wecom_links FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

-- 4.7 messages
DROP POLICY IF EXISTS messages_select_own ON public.messages;
CREATE POLICY messages_select_own ON public.messages FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
DROP POLICY IF EXISTS messages_insert_own ON public.messages;
CREATE POLICY messages_insert_own ON public.messages FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS messages_delete_own ON public.messages;
CREATE POLICY messages_delete_own ON public.messages FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());


-- ---------- 5. 模板表：官方模板公共只读，自建模板私有 ----------
DROP POLICY IF EXISTS templates_read ON public.agent_templates;
CREATE POLICY templates_read ON public.agent_templates FOR SELECT TO authenticated, anon
  USING (is_official = true OR owner_id = auth.uid());

DROP POLICY IF EXISTS templates_insert_own ON public.agent_templates;
CREATE POLICY templates_insert_own ON public.agent_templates FOR INSERT TO authenticated, anon
  WITH CHECK (owner_id = auth.uid() AND is_official = false);

DROP POLICY IF EXISTS templates_update_own ON public.agent_templates;
CREATE POLICY templates_update_own ON public.agent_templates FOR UPDATE TO authenticated, anon
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS templates_delete_own ON public.agent_templates;
CREATE POLICY templates_delete_own ON public.agent_templates FOR DELETE TO authenticated, anon
  USING (owner_id = auth.uid());
