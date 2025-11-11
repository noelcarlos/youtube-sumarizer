URL: https://www.youtube.com/watch?v=oiKO96w59Uc
Original language: English

This video demonstrates how to build a React component following modern best practices, design patterns, and clean architecture principles by developing a "smithing screen" for a real-world RPG side project. The presenter walks through the thought process and implementation, emphasizing composability, reusability, and the Single Responsibility Principle.

---

### Introduction and Project Context

The video focuses on building a **React component for an RPG game's "smithing screen."** This component allows users to interact with the smithing skill, which involves:
*   **Location Dependency:** All skills in the game are dependent on specific locations.
*   **Buildings:** Smithing actions (melting ore into bars, crafting items) occur in specific buildings like a "smithy" or a "furnace," which are found within certain "city" locations.
*   **Filtering:** Not all locations have smithy-compatible buildings, so the component must filter and display only relevant locations.
*   **Scope:** The video focuses on component patterns, not hooks or business logic, assuming existing helper functions and UI components are available for reuse.

---

### Core Principles and Design Patterns Highlighted

The video emphasizes several key development principles:

*   **Single Responsibility Principle (SRP):** Each component should have only one reason to change, making it small, composable, and reusable. This is a foundational concept throughout the build.
*   **Composability & Reusability:** Breaking down the UI into many small, focused components that can be composed together to build complex features.
*   **Clean Architecture:** Organizing code in a way that is maintainable, scalable, and easy to understand, by isolating concerns and delegating tasks.
*   **Utility Functions:** Extracting small, reusable helper functions for common logic (e.g., `getLocationsForSmithing`, `getLocationById`). This prevents bloating components and promotes DRY (Don't Repeat Yourself) code.
*   **Render Props Pattern:** A technique where a component receives a function via props that it calls to render parts of its UI. This delegates rendering responsibility to the parent component, increasing flexibility (demonstrated with the `ModalSelect` component).
*   **Type Safety with TypeScript:** Using TypeScript to ensure type correctness, especially when dealing with data that might vary (e.g., different `Location` types).

---

### Component Architecture Overview

The final smithing screen is composed of several smaller components:

1.  **Main Component (Implied `SmithingScreen`):** Manages the overall state (`selectedLocationId`, `selectedBuildingId`) and orchestrates the rendering of sub-components based on user selections.
2.  **`SmithingLocationSelector`:** Responsible for displaying valid locations and allowing the user to select one.
3.  **`SmithingBuildingSelector`:** Displays buildings relevant to the selected location and allows the user to choose one. This component only renders if a location has been selected.
4.  **`SmithingBuildingContent`:** Acts as a "triage" component, displaying the specific content (e.g., items to craft) based on the chosen building type. This component only renders if a building has been selected.
    *   **`SmithingBuildingFurnaceContent`:** Shows items relevant to the furnace (e.g., types of bars).
    *   **`SmithingBuildingSmithyContent`:** Shows items relevant to the smithy (e.g., armor/weapon recipes).

---

### Detailed Implementation Steps

#### 1. Location Selection

*   **State Initialization:** `useState` hooks are used to manage `selectedLocationId` and `selectedBuildingId`, both initialized to `null`.
*   **`SmithingLocationSelector` Component:**
    *   Takes `selectedLocationId`, `setSelectedLocationId`, and `setSelectedBuildingId` as props.
    *   **Purpose:** Its sole responsibility is to manage the selection of a smithing-compatible location.
    *   **Data Retrieval:** Uses the `getLocationsForSmithing` utility function to fetch an array of valid locations (cities with either a smithy or furnace building).
    *   **UI Component Reuse:** Renders a generic `ModalSelect` component (an existing reusable UI component from the project).
        *   **`ModalSelect` Props:** Requires `options` (an array of `{label: string, value: T}`), `selectedOption`, `onSelect`, and `renderOption`.
        *   **`options` mapping:** Transforms the `locations` array into the format expected by `ModalSelect` (`label: location.name`, `value: location.id`).
        *   **`onSelect` logic:** When a new location is selected, it updates `selectedLocationId` and **resets `selectedBuildingId` to `null`** (important for user experience, as a new location might not have the previously selected building).
        *   **`renderOption` (Render Props):** This is where the `LocationSelectCard` component is used. `ModalSelect` calls `renderOption` for each option, passing the `option` data and its internal `onSelect` handler (which handles modal animations and then calls the parent's `onSelect`).
    *   **`LocationSelectCard`:** Another existing component that visually represents a selectable location, using `getLocationById` and further breaking down its internal rendering into `LocationSelectCardContent`.

#### 2. Building Selection

*   **`SmithingBuildingSelector` Component:**
    *   Takes `locationId`, `selectedBuildingId`, and `setSelectedBuildingId` as props.
    *   **Conditional Rendering:** Only rendered in the main component if `selectedLocationId` is not `null`.
    *   **Data Retrieval & Type Casting:**
        *   Uses `getLocationById(locationId)` to get the full location object.
        *   **Type Casting:** The `location` object is type-cast as `LocationCity` (`location as LocationCity`) because the `getLocationsForSmithing` function guarantees that only city locations (which have buildings) were selected, preventing TypeScript errors when accessing `location.buildings`.
    *   **Building Filtering:** Filters `location.buildings` into `furnaceBuildings` and `smithyBuildings`.
    *   **UI Component Reuse:** Again, uses the `ModalSelect` component.
        *   **`options` mapping:** Combines `furnaceBuildings` and `smithyBuildings` and maps them to the `{label: string, value: string}` format. (The presenter notes that building names were hardcoded for simplicity but should ideally be part of the building data).
        *   **`onSelect` logic:** Simply updates `selectedBuildingId`. No need to reset location state.
        *   **`renderOption`:** For this component, simple JSX markup (a `TouchableOpactiy` with a `Card` and `Text`) is used directly within the `renderOption` function to display the building, although the presenter mentions this could also be refactored into a dedicated `BuildingSelectCard` component later.

#### 3. Content Display

*   **`SmithingBuildingContent` Component:**
    *   Takes `buildingId` as a prop.
    *   **Conditional Rendering:** Only rendered in the main component if `selectedBuildingId` is not `null`.
    *   **Data Retrieval & Type Casting:**
        *   Uses `getBuildingById(buildingId)` to fetch the building object.
        *   Type-casts the building as `BuildingFurnace` or `BuildingSmithy` to ensure type safety.
    *   **Triage Logic:** Based on `building.type`, it conditionally renders either `SmithingBuildingFurnaceContent` or `SmithingBuildingSmithyContent`.
    *   **`SmithingBuildingFurnaceContent`:**
        *   Receives the `building` object.
        *   Uses a `BarList` component (which also uses the render props pattern) to display available bars (e.g., bronze, iron).
        *   The `render` prop of `BarList` uses a `BarCard` component to render each individual bar, allowing navigation to a bar-specific page.
    *   **`SmithingBuildingSmithyContent`:**
        *   Receives the `building` object.
        *   Uses a `SmithingItemList` component (render props) to display available smithing items (e.g., plated body bronze).
        *   The `render` prop of `SmithingItemList` uses a `SmithingItemCard` to render each item.

---

### Key Takeaways and Benefits

*   **Clean and Understandable Code:** The resulting main component that orchestrates these sub-components is very concise (around 20 lines of code), making its purpose immediately clear and easy to follow.
*   **Maintainability and Scalability:** Small, focused components are easier to debug, modify, and extend. New features can be added by creating new small components or modifying existing ones without impacting others.
*   **Faster Development:** By leveraging existing reusable components and utility functions, the development of new features becomes significantly faster. The presenter notes that implementing entire skill trees (like woodcutting and mining) followed the same patterns and was completed quickly.
*   **Onboarding:** New developers can quickly understand and contribute to the codebase due to its clear structure and separation of concerns.

The video concludes by emphasizing that this approach of composing small, single-responsibility components is the ideal way to build modern React applications, leading to robust, scalable, and developer-friendly codebases.