# Artifacts

Artifacts is a preview environment to allow agents to share files on a persistant url. This means that an agent can write a text, markdown, or html file and share it via a url in chat. The intention is that this will allow the agent the ability to create plans, diagrams, and other artifacts that it can then share the url for, which is especially useful for work with an agent remotely.

The app is a small Tanstack Start application. It is started and managed by the local Docker infrastructure in the ~/homelab-infra project.

The base of the app is a VitePlus app using the defaults from the @dbtlr/tooling project.

Agents interact with it via an MCP service, that allows them to add new artifacts, update artifacts, as well as remove artifacts. When an artifact is added, a fully resolvable link is returned to be able to pass to the user. The base host can be configured to be overriden. Example, in my environment, with a caddy entry added, an application served at `http://localhost:12345` can be resolved across my tailscale network as `https://artifacts.valhalla.local`.

Types accepted: `html`, `md`, `txt`.

HTML documents are displayed as is, but markdown and text documents are rendered via a standard template.

Documents are intended to be easy to read on both desktop and mobile. Color choice should be simple and easy to read, as well as font choice.

Artifacts are added to a local folder in the project, that is not managed by `git`.

An Artifact should have a title, a project, and short description added with it, that help identify it in list views.

A list of artifacts, as well as the date they were added should be maintained on the homepage. Most recent artifacts at the top.

Artifact metadata is maintained in a local sqlite database (not managed by git).
