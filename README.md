# Edi
Markdown is becoming the modern format for writing text, diagrams, creating tables, and more.
However, while markdown is becoming an all-encompassing, modern version of office documents, the only existing editors are designed as if it's just a way to make some text look a little better.

Enter Edi. Edi is to be a modern, **exceedingly fast** markdown editor that lets you write up all of the amazing things that modern markdown has become, lets you compose diagrams in mermaid, and allows you to do in-line data processing on tables just like a mini-spreadsheet.

## Features
1. Small (low memory footprint) and fast
2. LocalHTML
3. In-line diagrams (supports everything the latest Mermaid JS diagrams support)
4. In-line spreadsheet capabilities (allow quick processing to and from tables), with an ability to enter equations like in other spreadsheet software
5. Ability to preview output as you type (via a toggle-able, resizable preview)
6. Executable code blocks via a type of in-line kernel support (using #! syntax on the blocks to determine the interpreter to use) that displays the output in a cell when the user executes the blocks (for example):

    #!/usr/bin/env python3
    print('Hi!')

7. Ability to quickly copy and paste fragments so they can be used in other places (in either plain text or in fragments)

## License
Ter is GPLv3 (or later) licensed

## Development process
1. All features are thoroughly tested using automated tests
2. Code is checked for duplication and poor quality using a free, open static code analysis tool
3. Versioning and tagging automatically results in releases being created by gitlab ci pipeline (using the new glab tools not the deprecated release-cli)
4. All unnecessary files are .gitignored
5. All files necessary for building the project can be installed via simple script so that a new developer or user can easily build the project from source
6. If there are available linting processes for the source files, part of the standard checks are to write and run them
7. Coverage metrics are available as part of the build and check process
