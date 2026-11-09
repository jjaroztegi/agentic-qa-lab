# FAQ

## Does it only work because there were tests to copy from?

No. With the `from-scratch` label the agent sees no existing tests or plans, only the case and the screens. Scenarios 02 and 08 run that way.

## Does it need the source code of our systems?

No. Black box is the default for bought systems and it is enforced: their code is not in the agent's workspace, and reads outside the workspace are denied. See [Agent boundaries](internals/agent-boundaries.md).

## What if the case is wrong or the application has a defect?

The agent keeps what the business wrote and reports the difference as a finding in the PR. It does not turn a defect into a passing test. A person decides whether the case or the application needs to change.

## Who decides whether a test is correct?

A person. The agent proposes the test in a pull request together with its plan, its report and a replay of the run. The test runs three times inside the agent and once more outside it before anyone reviews it. Nothing joins the suite without approval.

## Can the agent cause damage?

It works on disposable copies of the test environment, with a fixed list of tools. It can only reach the documented interfaces of its own run's ERP and MES. Everything it publishes is filtered for credentials.

## What does it cost, and how long does it take?

Every run records its duration and model cost, and the control room's Overview shows them per case. In the reference run of all eight scenarios, authoring took 2.4 to 9.5 minutes per case and US$0.50 to US$1.67 in model usage, plus a person's review.

## Does it scale?

Runs are independent. More runners mean more cases in parallel (scenario 07). Each run's ERP copy takes seconds to create.

## Are we locked in to a vendor?

Every part can be replaced. Tests are ordinary Playwright and Node tests that run without any AI. Pipeline steps are shell scripts that any CI system can call. The model is a setting, and agent instructions live in plain Markdown in `.agents/skills/`. The knowledge stays in the case catalog and in the tests.

## What about SAP GUI, Citrix or mainframe screens?

Desktop automation here uses the accessibility tree. SAP GUI for Windows has its own scripting interface, and Citrix only delivers pixels. Those need adapters or agents that work from screenshots. The lab does not cover them.

## Where does our data go?

What the agent sees goes to the model provider: screens and the test data in them. Use masked test data, a zero-retention agreement, or a self-hosted model where that is not acceptable.

## How do we start?

Pick a few critical processes that are tested by hand today and write them as cases. Run the lab against test copies of the real systems. Measure how much of each case the agent automates, and how much review time each test needs.
