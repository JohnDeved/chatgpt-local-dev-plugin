import { callsWidget } from "./calls.js";
import { commandWidget } from "./command.js";
import { projectWidget } from "./projects.js";
import { questionWidget } from "./question.js";
import { resourceContent, type UiResource } from "./common.js";

const resources: UiResource[] = [commandWidget, projectWidget, callsWidget, questionWidget];
const byUri = new Map(resources.map((resource) => [resource.uri, resource]));

export function listUiResources(): Array<{ name: string; uri: string; mimeType: string; description: string }> {
  return resources.map((resource) => ({
    name: resource.name,
    uri: resource.uri,
    mimeType: "text/html;profile=mcp-app",
    description: resource.description,
  }));
}

export function readUiResource(uri: string): ReturnType<typeof resourceContent> | undefined {
  const resource = byUri.get(uri);
  return resource === undefined ? undefined : resourceContent(resource);
}

export { attachWidget } from "./common.js";
export { CALLS_WIDGET_URI } from "./calls.js";
export { COMMAND_WIDGET_URI } from "./command.js";
export { PROJECT_WIDGET_URI } from "./projects.js";
export { QUESTION_WIDGET_URI } from "./question.js";
