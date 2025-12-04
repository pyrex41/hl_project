HumanLayer Take-Home Assessment
This assessment is solely for the purposes of evaluating your qualifications for a role at HumanLayer.
Nothing in this assessment will be used in HumanLayer’s products and/or systems. Neither
HumanLayer’s issuance of this assessment to you nor your completion of it constitute an offer of or
contract for employment at HumanLayer.
It is our expectation that this project should take no more than a few hours to complete. We encourage
you to spend as few as reasonably possible on it, and we ask that applicants spend no more than six
hours on it at maximum.
The objective of this assessment is not to determine how much code you can write or how many features
you can ship, and the assessment will not be evaluated on the basis of “feature completeness” against
existing coding agents. Rather, we want to understand how you approach the problem and design a
solution to it.
Task
● Create an AI coding agent which runs on the end-user’s device. It should have basic coding
agent capabilities including file editing, shell commands, and so forth.
○ The stack and harness design and prompts (or lack thereof) are entirely up to you.
● Create a web-based user interface for interacting with the agent through some type of chat-based
interface. A `localhost` server which runs on the same device as the coding agent is
recommended.
● The system MUST support streaming tool calls to the interface from the coding agent as the
agent is working.
Constraints
● Your project MUST be written entirely in TypeScript both for the frontend and for the coding agent
harness/backend
● You are free to use whatever libraries, toolchain, and packages that you would like with two
caveats:
1. You MUST NOT use the SDK of an existing coding agent (Claude Code, OpenCode,
Amp, Cursor, etc.) as your coding agent. You may use them for inspiration, but your
coding agent’s source code may not use their SDKs, binaries, or source code as direct or
indirect dependencies
2. Apart from an LLM API key for inference, the deliverable MUST NOT require paid
services, platforms or dependencies
● Your deliverable MAY require the end-user to configure an API key for an LLM inference provider
(Anthropic, OpenAI, Google) for the coding agent to work
○ or it may rely on locally-served models through llama.cpp or similar.
○ Ensure you provide configuration instructions in your deliverable.
● All your work done on the assessment MUST be tracked in your version control
Deliverables
Your deliverables should be contained within a publicly-accessible GitHub repository, containing:
● The full source code of your project, including the version history of your work on it through git
commits
● A README.md file at the root of the repository which contains:
○ A brief overview of the project describing the stack, architecture, design decisions,
features, etc.
■ If you include a video (see below) you may include this in the video instead
○ Sufficient instructions for a technical reviewer to get the project up-and-running for the
purposes of evaluating it
○ A section on which coding agent(s) you used, if any, and a brief overview of your process
& methodology for working with them.
○ Optional: the README may contain a link to a Loom video, an uploaded video, or similar
of you demonstrating using the assessment project
● If you worked with an AI coding agent on the project, you should include your configuration
directory (e.g. `.opencode`, `.claude`, `.cursor`, etc.) and any AGENTS.md or CLAUDE.md file
you used
