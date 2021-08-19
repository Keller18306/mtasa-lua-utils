import {
    AssignmentStatement,
    createIdentifier,
    createVariableDeclarationStatement,
    Identifier,
    Plugin,
    ReturnStatement,
    Statement,
    SyntaxKind,
    TableIndexExpression,
    TransformationContext,
    VariableDeclarationStatement,
    Visitor,
} from 'typescript-to-lua';
import * as ts from 'typescript';
import { DiagnosticCategory } from 'typescript';

import { FunctionVisitor } from 'typescript-to-lua/dist/transformation/context/visitors';
import { transformFunctionDeclaration } from 'typescript-to-lua/dist/transformation/visitors/function';
import {
    getExportsTableName,
    getGlobalsTableName,
    prepareOneToManyVisitorResult,
} from './utils';
import { Expression } from 'typescript-to-lua/dist/LuaAST';
import { getIdentifierSymbolId } from 'typescript-to-lua/dist/transformation/utils/symbols';
import { transformSourceFileNode } from 'typescript-to-lua/dist/transformation/visitors/sourceFile';
import {
    transformExportAssignment,
    transformExportDeclaration,
} from 'typescript-to-lua/dist/transformation/visitors/modules/export';
import { simpleTsDiagnostic } from '../compiler/utils';
import { transformVariableStatement } from 'typescript-to-lua/dist/transformation/visitors/variable-declaration';
import { transformClassDeclaration } from 'typescript-to-lua/dist/transformation/visitors/class';

interface ImportSpecifierToGlobalTable {
    namePattern: RegExp;
    modulePattern: RegExp;
}

// TODO: make configurable
const importSpecifiersMapToGlobalTable: ImportSpecifierToGlobalTable[] = [
    {
        namePattern: /^mtasa$/,
        modulePattern: /^mtasa-lua-types\/types\/mtasa\/(client|server)$/,
    },
];

const importDeclarationVisitor: FunctionVisitor<ts.ImportDeclaration> =
    function (node, context) {
        const importClause = node.importClause;
        if (importClause?.namedBindings === undefined) {
            return [];
        }
        if (importClause.namedBindings.kind !== ts.SyntaxKind.NamespaceImport) {
            const namedImports = importClause.namedBindings;
            if (node.moduleSpecifier.kind !== ts.SyntaxKind.StringLiteral) {
                return [];
            }
            const moduleSpecifier = node.moduleSpecifier as ts.StringLiteral;
            const module = moduleSpecifier.text;
            const specifiers: ImportSpecifierToGlobalTable[] =
                importSpecifiersMapToGlobalTable.filter(value =>
                    module.match(value.modulePattern),
                );

            if (specifiers.length === 0) {
                return [];
            }
            const specifier = specifiers[0];

            return namedImports.elements
                .filter(value =>
                    value.propertyName?.text.match(specifier.namePattern),
                )
                .map(value =>
                    createVariableDeclarationStatement(
                        createIdentifier(
                            value.name.text,
                            value.name,
                            getIdentifierSymbolId(context, value.name),
                        ),
                        createIdentifier('_G'),
                        value,
                    ),
                );
        }

        const namespaceImport = importClause.namedBindings;
        const name = namespaceImport.name.text;

        return [
            createVariableDeclarationStatement(
                createIdentifier(
                    name,
                    namespaceImport.name,
                    getIdentifierSymbolId(context, namespaceImport.name),
                ),
                createIdentifier('_G'),
                node,
            ),
        ];
    };

function statementListAntiExport(
    statements: Statement[] | Statement | undefined,
): Statement[] {
    const result = prepareOneToManyVisitorResult(statements);

    for (const statement of result) {
        if (statement.kind !== SyntaxKind.AssignmentStatement) {
            continue;
        }

        const declaration = statement as VariableDeclarationStatement;
        const left: Expression[] = declaration.left;
        if (left[0].kind !== SyntaxKind.TableIndexExpression) {
            continue;
        }

        const expression = left[0] as TableIndexExpression;
        if (expression.table.kind !== SyntaxKind.Identifier) {
            continue;
        }

        const tableIdentifier = expression.table as Identifier;
        if (tableIdentifier.text !== getExportsTableName()) {
            continue;
        }

        tableIdentifier.text = getGlobalsTableName();
    }

    return result;
}

const functionDeclarationAntiExport: FunctionVisitor<ts.FunctionDeclaration> =
    function (node, context) {
        const rawResult = transformFunctionDeclaration(node, context);
        return statementListAntiExport(rawResult);
    };

const variableStatementAntiExport: FunctionVisitor<ts.VariableStatement> =
    function (node, context) {
        const rawResult = transformVariableStatement(node, context);
        return statementListAntiExport(rawResult);
    };

const classDeclarationAntiExport: FunctionVisitor<ts.ClassLikeDeclaration> =
    function (node, context) {
        const rawResult = transformClassDeclaration(node, context);
        return statementListAntiExport(rawResult as any); // FIXME TODO
    };

const sourceFileRemoveExports: FunctionVisitor<ts.SourceFile> = function (
    node,
    context: TransformationContext,
) {
    const result = transformSourceFileNode(node, context);

    result.statements = result.statements.filter(statement => {
        if (statement.kind === SyntaxKind.VariableDeclarationStatement) {
            const declaration = statement as VariableDeclarationStatement;
            return !(
                declaration.left.length > 0 &&
                declaration.left[0].kind === SyntaxKind.Identifier &&
                declaration.left[0].text.indexOf('exports') !== -1
            );
        }
        if (statement.kind === SyntaxKind.ReturnStatement) {
            const declaration = statement as ReturnStatement;
            return !(
                declaration.expressions.length > 0 &&
                declaration.expressions[0].kind === SyntaxKind.Identifier &&
                (declaration.expressions[0] as Identifier).text.indexOf(
                    'exports',
                ) !== -1
            );
        }

        return true;
    });
    return result;
};

const removeExportDeclaration: FunctionVisitor<ts.ExportDeclaration> =
    function (node, context) {
        const rawResult = transformExportDeclaration(node, context);
        const result = prepareOneToManyVisitorResult(rawResult);

        for (const statement of result) {
            if (statement.kind !== SyntaxKind.AssignmentStatement) {
                continue;
            }

            const assignment = statement as AssignmentStatement;
            if (assignment.left.length === 0) {
                continue;
            }
            if (assignment.left[0].kind !== SyntaxKind.TableIndexExpression) {
                continue;
            }

            const expression = assignment.left[0] as TableIndexExpression;
            if (expression.table.kind !== 28) {
                continue;
            }

            const tableIdentifier = expression.table as Identifier;
            if (tableIdentifier.text.indexOf('exports') === -1) {
                continue;
            }
            tableIdentifier.text = '_G';
        }

        // result[0].
        return result;
    };

const removeExportAssignment: FunctionVisitor<ts.ExportAssignment> = function (
    node,
    context,
) {
    context.diagnostics.push(
        simpleTsDiagnostic(
            `Do not use export assignments (file: ${context.sourceFile.fileName})`,
            DiagnosticCategory.Warning,
        ),
    );
    return transformExportAssignment(node, context);
};

export default {
    // `visitors` is a record where keys are TypeScript node syntax kinds
    visitors: {
        // Visitor can be a function that returns Lua AST node
        [ts.SyntaxKind.SourceFile]: sourceFileRemoveExports,
        [ts.SyntaxKind.ImportDeclaration]: importDeclarationVisitor,
        [ts.SyntaxKind.ExportDeclaration]: removeExportDeclaration,
        [ts.SyntaxKind.ExportAssignment]: removeExportAssignment,
        [ts.SyntaxKind.FunctionDeclaration]: functionDeclarationAntiExport,
        [ts.SyntaxKind.VariableStatement]: variableStatementAntiExport,
        [ts.SyntaxKind.ClassDeclaration]: classDeclarationAntiExport,
    },
} as Plugin;
