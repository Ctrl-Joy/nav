import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { FullPageSpinner, RootLayout, RouteError } from './layouts/RootLayout';
import { RequireAuth } from './layouts/RequireAuth';
import { NotFoundPage } from './pages/NotFound';

/** Code-split route helper: `lazy(() => import('./pages/X'), 'ExportName')`. */
function page<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M & string): Pick<RouteObject, 'lazy'> {
  return {
    lazy: async () => {
      const mod = await loader();
      return { Component: mod[name] as ComponentType };
    },
  };
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    hydrateFallbackElement: <FullPageSpinner />,
    errorElement: <RouteError />,
    children: [
      { path: '/', ...page(() => import('./pages/Landing'), 'LandingPage') },
      { path: '/docs', ...page(() => import('./pages/Docs'), 'DocsPage') },
      { path: '/login', ...page(() => import('./pages/AuthPages'), 'LoginPage') },
      { path: '/signup', ...page(() => import('./pages/AuthPages'), 'SignupPage') },
      {
        element: <RequireAuth />,
        children: [
          { path: '/app', ...page(() => import('./pages/AppRedirect'), 'AppRedirect') },
          {
            path: '/w/:workspaceId',
            ...page(() => import('./layouts/WorkspaceLayout'), 'WorkspaceLayout'),
            children: [
              { index: true, ...page(() => import('./pages/Overview'), 'OverviewPage') },
              { path: 'services', element: <Navigate to=".." relative="path" replace /> },
              { path: 'get-started', ...page(() => import('./pages/Onboarding'), 'OnboardingPage') },
              { path: 'new/postgres', element: <Navigate to="../../databases/new" relative="path" replace /> },
              { path: 'new/blueprint', element: <Navigate to="../../blueprints/new" relative="path" replace /> },
              { path: 'new/:type', ...page(() => import('./pages/new/NewService'), 'NewServicePage') },
              {
                path: 'services/:serviceId',
                ...page(() => import('./pages/service/ServiceLayout'), 'ServiceLayout'),
                children: [
                  { index: true, ...page(() => import('./pages/service/ServiceEvents'), 'ServiceEventsTab') },
                  { path: 'deploys/:deployId', ...page(() => import('./pages/service/DeployDetail'), 'DeployDetailTab') },
                  { path: 'logs', ...page(() => import('./pages/service/ServiceLogs'), 'ServiceLogsTab') },
                  { path: 'metrics', ...page(() => import('./pages/service/ServiceMetrics'), 'ServiceMetricsTab') },
                  { path: 'environment', ...page(() => import('./pages/service/ServiceEnvironment'), 'ServiceEnvironmentTab') },
                  { path: 'scaling', ...page(() => import('./pages/service/ServiceScaling'), 'ServiceScalingTab') },
                  { path: 'previews', ...page(() => import('./pages/service/ServicePreviews'), 'ServicePreviewsTab') },
                  { path: 'jobs', ...page(() => import('./pages/service/ServiceJobs'), 'ServiceJobsTab') },
                  { path: 'settings', ...page(() => import('./pages/service/ServiceSettings'), 'ServiceSettingsTab') },
                ],
              },
              { path: 'databases', ...page(() => import('./pages/databases/DatabasesList'), 'DatabasesPage') },
              { path: 'databases/new', ...page(() => import('./pages/databases/NewDatabase'), 'NewDatabasePage') },
              {
                path: 'databases/:databaseId',
                ...page(() => import('./pages/databases/DatabaseLayout'), 'DatabaseLayout'),
                children: [
                  { index: true, ...page(() => import('./pages/databases/DatabaseInfo'), 'DatabaseInfoTab') },
                  { path: 'logs', ...page(() => import('./pages/databases/DatabaseTabs'), 'DatabaseLogsTab') },
                  { path: 'metrics', ...page(() => import('./pages/databases/DatabaseTabs'), 'DatabaseMetricsTab') },
                  { path: 'backups', ...page(() => import('./pages/databases/DatabaseTabs'), 'DatabaseBackupsTab') },
                  { path: 'access', ...page(() => import('./pages/databases/DatabaseTabs'), 'DatabaseAccessTab') },
                  { path: 'query', ...page(() => import('./pages/databases/DatabaseQuery'), 'DatabaseQueryTab') },
                  { path: 'settings', ...page(() => import('./pages/databases/DatabaseTabs'), 'DatabaseSettingsTab') },
                ],
              },
              { path: 'env-groups', ...page(() => import('./pages/envgroups/EnvGroups'), 'EnvGroupsPage') },
              { path: 'env-groups/:groupId', ...page(() => import('./pages/envgroups/EnvGroupDetail'), 'EnvGroupDetailPage') },
              { path: 'blueprints', ...page(() => import('./pages/blueprints/Blueprints'), 'BlueprintsPage') },
              { path: 'blueprints/new', ...page(() => import('./pages/blueprints/NewBlueprint'), 'NewBlueprintPage') },
              { path: 'blueprints/:blueprintId', ...page(() => import('./pages/blueprints/BlueprintDetail'), 'BlueprintDetailPage') },
              { path: 'projects', ...page(() => import('./pages/Projects'), 'ProjectsPage') },
              { path: 'activity', ...page(() => import('./pages/Activity'), 'ActivityPage') },
              { path: 'settings', ...page(() => import('./pages/settings/WorkspaceSettings'), 'WorkspaceSettingsPage') },
              { path: 'api-keys', ...page(() => import('./pages/settings/ApiKeys'), 'ApiKeysPage') },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
