export type LocalEngine = 'python' | 'js' | 'clang';

export interface Language {
  id: string;
  label: string;
  /** Monaco language id. */
  monaco: string;
  /** Default entry file. */
  entry: string;
  /** Runs in the browser when set. */
  local?: LocalEngine;
  /** Wandbox `language` value, when a cloud compiler exists. */
  wandbox?: string;
  /** Tried first when Wandbox's newest version of a compiler is broken. */
  preferredCompiler?: string;
  /** Piston language name, for people who self-host Piston. */
  piston?: string;
  /** Default compiler flags (Clang and GCC). */
  flags?: string;
  /** Sample stdin for cloud languages, which cannot pause for input. */
  sampleInput?: string;
  template: string;
}

const GREET_INPUT = 'Ada\n';

export const LANGUAGES: Language[] = [
  {
    id: 'python',
    label: 'Python',
    monaco: 'python',
    entry: 'main.py',
    local: 'python',
    template: `name = input("What's your name? ")
print(f"Hello, {name}!")

squares = [n * n for n in range(1, 6)]
print("Squares:", squares)
`,
  },
  {
    id: 'c',
    label: 'C',
    monaco: 'c',
    entry: 'main.c',
    local: 'clang',
    wandbox: 'C',
    piston: 'c',
    flags: '-std=c17 -O1 -Wall',
    template: `#include <stdio.h>

int main(void) {
    char name[64];
    printf("What's your name? ");
    if (scanf("%63s", name) != 1) return 1;
    printf("Hello, %s!\\n", name);
    return 0;
}
`,
  },
  {
    id: 'cpp',
    label: 'C++',
    monaco: 'cpp',
    entry: 'main.cpp',
    local: 'clang',
    wandbox: 'C++',
    piston: 'c++',
    flags: '-std=c++20 -O1 -Wall',
    template: `#include <iostream>
#include <string>
#include <vector>

int main() {
    std::string name;
    std::cout << "What's your name? ";
    std::cin >> name;
    std::cout << "Hello, " << name << "!\\n";

    std::vector<int> squares;
    for (int n = 1; n <= 5; n++) squares.push_back(n * n);
    for (int s : squares) std::cout << s << ' ';
    std::cout << '\\n';
}
`,
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    monaco: 'javascript',
    entry: 'main.js',
    local: 'js',
    template: `const name = prompt("What's your name? ");
console.log(\`Hello, \${name}!\`);

const squares = [1, 2, 3, 4, 5].map((n) => n * n);
console.log("Squares:", squares);
`,
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    monaco: 'typescript',
    entry: 'main.ts',
    local: 'js',
    template: `const name: string = prompt("What's your name? ") ?? "stranger";
console.log(\`Hello, \${name}!\`);

const squares: number[] = [1, 2, 3, 4, 5].map((n) => n * n);
console.log("Squares:", squares);
`,
  },
  {
    id: 'java',
    label: 'Java',
    monaco: 'java',
    entry: 'Main.java',
    wandbox: 'Java',
    piston: 'java',
    sampleInput: GREET_INPUT,
    template: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        String name = in.nextLine();
        System.out.println("Hello, " + name + "!");
    }
}
`,
  },
  {
    id: 'go',
    label: 'Go',
    monaco: 'go',
    entry: 'main.go',
    wandbox: 'Go',
    piston: 'go',
    sampleInput: GREET_INPUT,
    template: `package main

import "fmt"

func main() {
	var name string
	fmt.Scanln(&name)
	fmt.Printf("Hello, %s!\\n", name)
}
`,
  },
  {
    id: 'rust',
    label: 'Rust',
    monaco: 'rust',
    entry: 'main.rs',
    wandbox: 'Rust',
    piston: 'rust',
    sampleInput: GREET_INPUT,
    template: `use std::io;

fn main() {
    let mut name = String::new();
    io::stdin().read_line(&mut name).expect("read failed");
    println!("Hello, {}!", name.trim());
}
`,
  },
  {
    id: 'csharp',
    label: 'C#',
    monaco: 'csharp',
    entry: 'Program.cs',
    wandbox: 'C#',
    piston: 'csharp',
    sampleInput: GREET_INPUT,
    template: `using System;

class Program {
    static void Main() {
        string name = Console.ReadLine();
        Console.WriteLine($"Hello, {name}!");
    }
}
`,
  },
  {
    id: 'ruby',
    label: 'Ruby',
    monaco: 'ruby',
    entry: 'main.rb',
    wandbox: 'Ruby',
    piston: 'ruby',
    sampleInput: GREET_INPUT,
    template: `name = gets&.chomp
puts "Hello, #{name}!"
`,
  },
  {
    id: 'php',
    label: 'PHP',
    monaco: 'php',
    entry: 'main.php',
    wandbox: 'PHP',
    piston: 'php',
    sampleInput: GREET_INPUT,
    template: `<?php
$name = trim(fgets(STDIN));
echo "Hello, $name!\\n";
`,
  },
  {
    id: 'bash',
    label: 'Bash',
    monaco: 'shell',
    entry: 'main.sh',
    wandbox: 'Bash script',
    piston: 'bash',
    sampleInput: GREET_INPUT,
    template: `read -r name
echo "Hello, $name!"
`,
  },
  {
    id: 'lua',
    label: 'Lua',
    monaco: 'lua',
    entry: 'main.lua',
    wandbox: 'Lua',
    piston: 'lua',
    sampleInput: GREET_INPUT,
    template: `local name = io.read("l")
print("Hello, " .. name .. "!")
`,
  },
  {
    id: 'perl',
    label: 'Perl',
    monaco: 'perl',
    entry: 'main.pl',
    wandbox: 'Perl',
    piston: 'perl',
    sampleInput: GREET_INPUT,
    template: `my $name = <STDIN>;
chomp $name;
print "Hello, $name!\\n";
`,
  },
  {
    id: 'haskell',
    label: 'Haskell',
    monaco: 'plaintext',
    entry: 'main.hs',
    wandbox: 'Haskell',
    piston: 'haskell',
    sampleInput: GREET_INPUT,
    template: `main :: IO ()
main = do
  name <- getLine
  putStrLn ("Hello, " ++ name ++ "!")
`,
  },
  {
    id: 'scala',
    label: 'Scala',
    monaco: 'scala',
    entry: 'main.scala',
    wandbox: 'Scala',
    preferredCompiler: 'scala-3.3.4',
    piston: 'scala',
    sampleInput: GREET_INPUT,
    template: `object Main {
  def main(args: Array[String]): Unit = {
    val name = scala.io.StdIn.readLine()
    println(s"Hello, $name!")
  }
}
`,
  },
  {
    id: 'r',
    label: 'R',
    monaco: 'r',
    entry: 'main.R',
    wandbox: 'R',
    piston: 'rscript',
    sampleInput: GREET_INPUT,
    template: `name <- readLines(file("stdin"), n = 1)
cat("Hello, ", name, "!\\n", sep = "")
`,
  },
  {
    id: 'zig',
    label: 'Zig',
    monaco: 'plaintext',
    entry: 'main.zig',
    wandbox: 'Zig',
    piston: 'zig',
    template: `const std = @import("std");

pub fn main() void {
    std.debug.print("Hello from Zig!\\n", .{});
}
`,
  },
  {
    id: 'sql',
    label: 'SQL (SQLite)',
    monaco: 'sql',
    entry: 'main.sql',
    wandbox: 'SQL',
    piston: 'sqlite3',
    template: `CREATE TABLE students (name TEXT, marks INT);
INSERT INTO students VALUES ('Ada', 91), ('Linus', 78), ('Grace', 96);
SELECT name, marks FROM students ORDER BY marks DESC;
`,
  },
  {
    id: 'pascal',
    label: 'Pascal',
    monaco: 'pascal',
    entry: 'main.pas',
    wandbox: 'Pascal',
    piston: 'pascal',
    sampleInput: GREET_INPUT,
    template: `program Greet;
var name: string;
begin
  readln(name);
  writeln('Hello, ', name, '!');
end.
`,
  },
];

const byId = new Map(LANGUAGES.map((language) => [language.id, language]));

export function getLanguage(id: string): Language {
  return byId.get(id) ?? LANGUAGES[0];
}

/** Picks a language for a file so uploads and shared files get the right highlighting. */
export function monacoLanguageForFile(fileName: string, fallback: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    py: 'python', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', js: 'javascript',
    mjs: 'javascript', ts: 'typescript', java: 'java', go: 'go', rs: 'rust', cs: 'csharp', rb: 'ruby',
    php: 'php', sh: 'shell', swift: 'swift', lua: 'lua', pl: 'perl', scala: 'scala', r: 'r', sql: 'sql',
    pas: 'pascal', json: 'json', md: 'markdown', txt: 'plaintext', csv: 'plaintext', html: 'html', css: 'css',
  };
  return map[ext] ?? fallback;
}
