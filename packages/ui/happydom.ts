import { GlobalRegistrator } from "@happy-dom/global-registrator"

// Solid JSX components reach DOM globals (template()/delegateEvents()) while
// their module body evaluates. Register a DOM before any component module
// loads so a plain `bun test` can import .tsx sources.
GlobalRegistrator.register()
