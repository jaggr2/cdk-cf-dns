import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Generates API.md from the public exports of `src/index.ts`.
 *
 * This is a deliberately plain TypeScript-compiler-API script (no jsii, no
 * projen) that walks the exported declarations and renders their TSDoc comments
 * and signatures into a single markdown reference document.
 */

const root = path.join(__dirname, '..');
const indexPath = path.join(root, 'src', 'index.ts');

const program = ts.createProgram([indexPath], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  esModuleInterop: true,
  strict: true,
  skipLibCheck: true,
});

const checker = program.getTypeChecker();

interface DocNode {
  name: string;
  doc: string;
  decl: ts.Declaration;
}

function getDoc(node: ts.Node): string {
  const jsDocs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs || jsDocs.length === 0) {
    return '';
  }
  return jsDocs
    .map((doc) => (Array.isArray(doc.comment) ? doc.comment.map((p) => p.text).join('') : (doc.comment as string ?? '')))
    .join('\n')
    .trim();
}

function typeOf(node: ts.TypeNode | undefined): string {
  if (!node) {
    return '';
  }
  const type = checker.getTypeFromTypeNode(node);
  return checker.typeToString(type, node);
}

function heritageOf(node: ts.InterfaceDeclaration | ts.ClassDeclaration): string {
  const clauses = node.heritageClauses?.filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword) ?? [];
  return clauses
    .flatMap((c) => c.types.map((t) => checker.typeToString(checker.getTypeAtLocation(t))))
    .join(', ');
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as unknown as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

function anchor(kind: string, name: string): string {
  return `#${kind.toLowerCase()}${name.toLowerCase()}`;
}

function renderEnums(docs: DocNode[]): string {
  const out: string[] = ['## Enums'];
  for (const { name, doc, decl } of docs) {
    const enumDecl = decl as ts.EnumDeclaration;
    out.push('', `### ${name}`, '');
    if (doc) {
      out.push(doc, '');
    }
    out.push('| Name | Description |', '|------|-------------|');
    for (const member of enumDecl.members) {
      const memberName = (member.name as ts.Identifier).text;
      const memberDoc = getDoc(member).replace(/\n/g, ' ');
      out.push(`| \`${memberName}\` | ${memberDoc} |`);
    }
  }
  return out.join('\n');
}

function renderInterfaces(docs: DocNode[]): string {
  const out: string[] = ['## Interfaces'];
  for (const { name, doc, decl } of docs) {
    const iface = decl as ts.InterfaceDeclaration;
    out.push('', `### ${name}`, '');
    if (doc) {
      out.push(doc, '');
    }
    const heritage = heritageOf(iface);
    if (heritage) {
      out.push(`Extends: \`${heritage}\``, '');
    }
    out.push('| Name | Type | Description |', '|------|------|-------------|');
    for (const member of iface.members) {
      if (ts.isPropertySignature(member)) {
        const memberName = member.name.getText(iface.getSourceFile());
        const optional = member.questionToken ? '?' : '';
        out.push(`| \`${memberName}${optional}\` | \`${typeOf(member.type)}\` | ${getDoc(member).replace(/\n/g, ' ')} |`);
      } else if (ts.isMethodSignature(member)) {
        const memberName = member.name.getText(iface.getSourceFile());
        const signature = checker.signatureToString(checker.getSignatureFromDeclaration(member)!);
        out.push(`| \`${memberName}?\` | \`${signature}\` | ${getDoc(member).replace(/\n/g, ' ')} |`);
      }
    }
  }
  return out.join('\n');
}

interface ClassSection {
  title: string;
  rows: string[];
}

function renderClasses(docs: DocNode[]): string {
  const out: string[] = ['## Classes'];
  for (const { name, doc, decl } of docs) {
    const cls = decl as ts.ClassDeclaration;
    const sourceFile = cls.getSourceFile();
    out.push('', `### ${name}`, '');
    if (doc) {
      out.push(doc, '');
    }
    const heritage = heritageOf(cls);
    if (heritage) {
      out.push(`Extends: \`${heritage}\``, '');
    }

    const sections: ClassSection[] = [];

    const constructors = cls.members.filter(ts.isConstructorDeclaration);
    const constructorRows: string[] = [];
    for (const ctor of constructors) {
      const isPrivate = hasModifier(ctor, ts.SyntaxKind.PrivateKeyword);
      const params = ctor.parameters.map((p) => `${p.name.getText(sourceFile)}: ${typeOf(p.type)}`).join(', ');
      const ctorDoc = getDoc(ctor).replace(/\n/g, ' ');
      const visibility = isPrivate ? ' *(private)*' : '';
      constructorRows.push(`| \`new ${name}(${params})\` | ${ctorDoc}${visibility} |`);
    }
    if (constructorRows.length > 0) {
      sections.push({ title: 'Constructor', rows: constructorRows });
    }

    const propertyRows: string[] = [];
    const methodRows: string[] = [];
    for (const member of cls.members) {
      const isPrivate = hasModifier(member, ts.SyntaxKind.PrivateKeyword);
      const isProtected = hasModifier(member, ts.SyntaxKind.ProtectedKeyword);
      if (isPrivate || isProtected) {
        continue;
      }
      const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
      const memberName = member.name?.getText(sourceFile) ?? '';
      const memberDoc = getDoc(member).replace(/\n/g, ' ');

      if (ts.isPropertyDeclaration(member) || ts.isGetAccessor(member)) {
        const optional = ts.isPropertyDeclaration(member) && member.questionToken ? '?' : '';
        const staticPrefix = isStatic ? 'static ' : '';
        propertyRows.push(`| \`${staticPrefix}${memberName}${optional}: ${typeOf(member.type)} (readonly)\` | ${memberDoc} |`);
      } else if (ts.isMethodDeclaration(member)) {
        const signature = checker.signatureToString(checker.getSignatureFromDeclaration(member)!);
        const staticPrefix = isStatic ? 'static ' : '';
        methodRows.push(`| \`${staticPrefix}${memberName}${signature}\` | ${memberDoc} |`);
      }
    }
    if (propertyRows.length > 0) {
      sections.push({ title: 'Properties', rows: propertyRows });
    }
    if (methodRows.length > 0) {
      sections.push({ title: 'Methods', rows: methodRows });
    }

    for (const section of sections) {
      out.push('', `#### ${section.title}`, '');
      out.push('| Name | Description |', '|------|-------------|');
      out.push(...section.rows);
    }
  }
  return out.join('\n');
}

function collect(): { enums: DocNode[]; interfaces: DocNode[]; classes: DocNode[]; aliases: DocNode[] } {
  const sourceFile = program.getSourceFile(indexPath);
  if (!sourceFile) {
    throw new Error(`Could not load ${indexPath}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`Could not resolve module symbol for ${indexPath}`);
  }

  const enums: DocNode[] = [];
  const interfaces: DocNode[] = [];
  const classes: DocNode[] = [];
  const aliases: DocNode[] = [];

  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const decl = symbol.getDeclarations()?.[0];
    if (!decl) {
      continue;
    }
    const doc: DocNode = { name: symbol.name, doc: getDoc(decl), decl };
    if (ts.isEnumDeclaration(decl)) {
      enums.push(doc);
    } else if (ts.isInterfaceDeclaration(decl)) {
      interfaces.push(doc);
    } else if (ts.isClassDeclaration(decl)) {
      classes.push(doc);
    } else if (ts.isTypeAliasDeclaration(decl)) {
      aliases.push(doc);
    }
  }

  enums.sort((a, b) => a.name.localeCompare(b.name));
  interfaces.sort((a, b) => a.name.localeCompare(b.name));
  classes.sort((a, b) => a.name.localeCompare(b.name));
  aliases.sort((a, b) => a.name.localeCompare(b.name));

  return { enums, interfaces, classes, aliases };
}

function renderAliases(aliases: DocNode[]): string {
  const out: string[] = ['## Type Aliases'];
  for (const { name, doc, decl } of aliases) {
    const alias = decl as ts.TypeAliasDeclaration;
    out.push('', `### ${name}`, '');
    if (doc) {
      out.push(doc, '');
    }
    out.push(`\`type ${name} = ${typeOf(alias.type)}\``, '');
  }
  return out.join('\n');
}

function toc(enums: DocNode[], interfaces: DocNode[], classes: DocNode[], aliases: DocNode[]): string {
  const out: string[] = ['## Table of contents'];
  if (enums.length > 0) {
    out.push('* **Enums**');
    out.push(...enums.map((e) => `  * [${e.name}](${anchor('Enums', e.name)})`));
  }
  if (interfaces.length > 0) {
    out.push('* **Interfaces**');
    out.push(...interfaces.map((i) => `  * [${i.name}](${anchor('Interfaces', i.name)})`));
  }
  if (classes.length > 0) {
    out.push('* **Classes**');
    out.push(...classes.map((c) => `  * [${c.name}](${anchor('Classes', c.name)})`));
  }
  if (aliases.length > 0) {
    out.push('* **Type Aliases**');
    out.push(...aliases.map((a) => `  * [${a.name}](${anchor('TypeAliases', a.name)})`));
  }
  return out.join('\n');
}

function main(): void {
  const { enums, interfaces, classes, aliases } = collect();

  const sections: string[] = [
    '# API Reference',
    '',
    `The public API surface of \`@jaggr2/cdk-cf-dns\`.`,
    '',
    toc(enums, interfaces, classes, aliases),
    '',
    '---',
    '',
    renderEnums(enums),
    '',
    '---',
    '',
    renderInterfaces(interfaces),
    '',
    '---',
    '',
    renderClasses(classes),
  ];

  if (aliases.length > 0) {
    sections.push('', '---', '', renderAliases(aliases));
  }

  sections.push('');
  sections.push('*This document is generated by `npm run docs`; do not edit by hand.*');
  sections.push('');

  const target = path.join(root, 'API.md');
  fs.writeFileSync(target, sections.join('\n'));
  process.stdout.write(`Wrote ${target}\n`);
}

main();
