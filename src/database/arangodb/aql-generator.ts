import { Field, Relation, RootEntityType } from '../../model';
import {
    AddEdgesQueryNode,
    BasicType,
    BinaryOperationQueryNode,
    BinaryOperator,
    ConcatListsQueryNode,
    ConditionalQueryNode,
    ConstBoolQueryNode,
    ConstIntQueryNode,
    CountQueryNode,
    CreateEntityQueryNode,
    DeleteEntitiesQueryNode,
    EdgeIdentifier,
    EntitiesQueryNode,
    EntityFromIdQueryNode,
    FieldQueryNode,
    FirstOfListQueryNode,
    FollowEdgeQueryNode,
    ListQueryNode,
    LiteralQueryNode,
    MergeObjectsQueryNode,
    NullQueryNode,
    ObjectQueryNode,
    OrderDirection,
    OrderSpecification,
    PartialEdgeIdentifier,
    QueryNode,
    QueryResultValidator,
    RemoveEdgesQueryNode,
    RootEntityIDQueryNode,
    RUNTIME_ERROR_TOKEN,
    RuntimeErrorQueryNode,
    SafeListQueryNode,
    SetEdgeQueryNode,
    OperatorWithLanguageQueryNode,
    BinaryOperatorWithLanguage,
    TransformListQueryNode,
    TypeCheckQueryNode,
    UnaryOperationQueryNode,
    UnaryOperator,
    UpdateEntitiesQueryNode,
    VariableAssignmentQueryNode,
    VariableQueryNode,
    WithPreExecutionQueryNode
} from '../../query-tree';
import { Quantifier, QuantifierFilterNode } from '../../query-tree/quantifiers';
import { extractVariableAssignments, simplifyBooleans } from '../../query-tree/utils';
import { not } from '../../schema-generation/filter-input-types/constants';
import { Constructor, decapitalize } from '../../utils/utils';
import { analyzeLikePatternPrefix } from '../like-helpers';
import { aql, AQLCompoundQuery, aqlConfig, AQLFragment, AQLQueryResultVariable, AQLVariable } from './aql';
import { getCollectionNameForRelation, getCollectionNameForRootEntity } from './arango-basics';
import { getViewNameForRootEntity, IDENTITY_ANALYZER } from './schema-migration/arango-search-helpers';
import { QuickSearchQueryNode } from '../../query-tree/quick-search';

enum AccessType {
    READ,
    WRITE
}

class QueryContext {
    private variableMap = new Map<VariableQueryNode, AQLVariable>();
    private preExecQueries: AQLCompoundQuery[] = [];
    private readAccessedCollections = new Set<string>();
    private writeAccessedCollections = new Set<string>();

    /**
     * Creates a new QueryContext with an independent variable map except that all query result variables of this
     * context are available.
     */
    private newPreExecContext(): QueryContext {
        const newContext = new QueryContext();
        this.variableMap.forEach((aqlVar, varNode) => {
            if (aqlVar instanceof AQLQueryResultVariable) {
                newContext.variableMap.set(varNode, aqlVar);
            }
        });
        newContext.readAccessedCollections = this.readAccessedCollections;
        newContext.writeAccessedCollections = this.writeAccessedCollections;
        return newContext;
    }

    /**
     * Creates a new QueryContext that is identical to this one but has one additional variable binding
     * @param variableNode the variable token as it is referenced in the query tree
     * @param aqlVariable the variable token as it will be available within the AQL fragment
     */
    private newNestedContextWithNewVariable(variableNode: VariableQueryNode, aqlVariable: AQLVariable): QueryContext {
        if (this.variableMap.has(variableNode)) {
            throw new Error(`Variable ${variableNode} is introduced twice`);
        }
        const newContext = new QueryContext();
        newContext.variableMap = new Map(this.variableMap);
        newContext.variableMap.set(variableNode, aqlVariable);
        newContext.preExecQueries = this.preExecQueries;
        newContext.readAccessedCollections = this.readAccessedCollections;
        newContext.writeAccessedCollections = this.writeAccessedCollections;
        return newContext;
    }

    /**
     * Creates a new QueryContext that is identical to this one but has one additional variable binding
     *
     * The AQLFragment for the variable will be available via getVariable().
     *
     * @param {VariableQueryNode} variableNode the variable as referenced in the query tree
     * @returns {QueryContext} the nested context
     */
    introduceVariable(variableNode: VariableQueryNode): QueryContext {
        const variable = new AQLVariable(variableNode.label);
        return this.newNestedContextWithNewVariable(variableNode, variable);
    }

    /**
     * Creates a new QueryContext that includes an additional transaction step and adds resultVariable to the scope
     * which will contain the result of the query
     *
     * The preExecQuery is evaluated in an independent context that has access to all previous preExecQuery result
     * variables.
     *
     * @param preExecQuery the query to execute as transaction step
     * @param resultVariable the variable to store the query result
     * @param resultValidator an optional validator for the query result
     */
    addPreExecuteQuery(preExecQuery: QueryNode, resultVariable?: VariableQueryNode, resultValidator?: QueryResultValidator): QueryContext {
        let resultVar: AQLQueryResultVariable | undefined;
        let newContext: QueryContext;
        if (resultVariable) {
            resultVar = new AQLQueryResultVariable(resultVariable.label);
            newContext = this.newNestedContextWithNewVariable(resultVariable, resultVar);
        } else {
            resultVar = undefined;
            newContext = this;
        }

        const aqlQuery = createAQLCompoundQuery(preExecQuery, resultVar, resultValidator, this.newPreExecContext());

        this.preExecQueries.push(aqlQuery);
        return newContext;
    }

    /**
     * Adds the information (in-place) that a collection is accessed
     */
    addCollectionAccess(collection: string, accessType: AccessType): void {
        switch (accessType) {
            case AccessType.READ:
                this.readAccessedCollections.add(collection);
                break;
            case AccessType.WRITE:
                this.writeAccessedCollections.add(collection);
                break;
        }
    }

    /**
     * Gets an AQLFragment that evaluates to the value of a variable in the current scope
     */
    getVariable(variableNode: VariableQueryNode): AQLFragment {
        const variable = this.variableMap.get(variableNode);
        if (!variable) {
            throw new Error(`Variable ${variableNode.toString()} is used but not introduced`);
        }
        return aql`${variable}`;
    }

    getPreExecuteQueries(): AQLCompoundQuery[] {
        return this.preExecQueries;
    }

    getReadAccessedCollections(): string[] {
        return Array.from(this.readAccessedCollections);
    }

    getWriteAccessedCollections(): string[] {
        return Array.from(this.writeAccessedCollections);
    }
}

function createAQLCompoundQuery(node: QueryNode,
                                resultVariable: AQLQueryResultVariable | undefined,
                                resultValidator: QueryResultValidator | undefined,
                                context: QueryContext): AQLCompoundQuery {
    // move LET statements up
    // they often occur for value objects / entity extensions
    // this avoids the FIRST() and the subquery which reduces load on the AQL query optimizer
    let variableAssignments: AQLFragment[] = [];
    const variableAssignmentNodes: VariableAssignmentQueryNode[] = [];
    node = extractVariableAssignments(node, variableAssignmentNodes);
    for (const assignmentNode of variableAssignmentNodes) {
        context = context.introduceVariable(assignmentNode.variableNode);
        const tmpVar = context.getVariable(assignmentNode.variableNode);
        variableAssignments.push(aql`LET ${tmpVar} = ${processNode(assignmentNode.variableValueNode, context)}`);
    }

    const aqlQuery = aql.lines(
        ...variableAssignments,
        aql`RETURN ${processNode(node, context)}`
    );
    const preExecQueries = context.getPreExecuteQueries();
    const readAccessedCollections = context.getReadAccessedCollections();
    const writeAccessedCollections = context.getWriteAccessedCollections();

    return new AQLCompoundQuery(preExecQueries, aqlQuery, resultVariable, resultValidator, readAccessedCollections, writeAccessedCollections);
}

type NodeProcessor<T extends QueryNode> = (node: T, context: QueryContext) => AQLFragment;

namespace aqlExt {
    export function safeJSONKey(key: string): AQLFragment {
        if (aql.isSafeIdentifier(key)) {
            return aql`${aql.string(key)}`; // if safe, use "name" approach
        } else {
            return aql`${key}`; // fall back to bound values
        }
    }

    export function parenthesizeList(...content: AQLFragment[]): AQLFragment {
        return aql.lines(
            aql`(`,
            aql.indent(aql.lines(...content)),
            aql`)`
        );
    }

    export function parenthesizeObject(...content: AQLFragment[]): AQLFragment {
        return aql`FIRST${parenthesizeList(...content)}`;
    }
}

const processors = new Map<Constructor<QueryNode>, NodeProcessor<QueryNode>>();

function register<T extends QueryNode>(type: Constructor<T>, processor: NodeProcessor<T>) {
    processors.set(type, processor as NodeProcessor<QueryNode>); // probably some bivariancy issue
}

register(LiteralQueryNode, node => {
    return aql.value(node.value);
});

register(NullQueryNode, () => {
    return aql`null`;
});

register(RuntimeErrorQueryNode, node => {
    const runtimeErrorToken = aql.code(RUNTIME_ERROR_TOKEN);
    return aql`{${runtimeErrorToken}: ${node.message}}`;
});

register(ConstBoolQueryNode, node => {
    return node.value ? aql`true` : aql`false`;
});

register(ConstIntQueryNode, node => {
    return aql.integer(node.value);
});

register(ObjectQueryNode, (node, context) => {
    if (!node.properties.length) {
        return aql`{}`;
    }

    const properties = node.properties.map(p =>
        aql`${aqlExt.safeJSONKey(p.propertyName)}: ${processNode(p.valueNode, context)}`);
    return aql.lines(
        aql`{`,
        aql.indent(aql.join(properties, aql`,\n`)),
        aql`}`
    );
});

register(ListQueryNode, (node, context) => {
    if (!node.itemNodes.length) {
        return aql`[]`;
    }

    return aql.lines(
        aql`[`,
        aql.indent(aql.join(node.itemNodes.map(itemNode => processNode(itemNode, context)), aql`,\n`)),
        aql`]`
    );
});


register(ConcatListsQueryNode, (node, context) => {
    const listNodes = node.listNodes.map(node => processNode(node, context));
    const listNodeStr = aql.join(listNodes, aql`, `);
    // note: UNION just appends, there is a special UNION_DISTINCT to filter out duplicates
    return aql`UNION(${listNodeStr})`;
});

register(VariableQueryNode, (node, context) => {
    return context.getVariable(node);
});

register(VariableAssignmentQueryNode, (node, context) => {
    const newContext = context.introduceVariable(node.variableNode);
    const tmpVar = newContext.getVariable(node.variableNode);

    // note that we have to know statically if the context var is a list or an object
    // assuming object here because lists are not needed currently
    return aqlExt.parenthesizeObject(
        aql`LET ${tmpVar} = ${processNode(node.variableValueNode, newContext)}`,
        aql`RETURN ${processNode(node.resultNode, newContext)}`
    );
});

register(WithPreExecutionQueryNode, (node, context) => {
    let currentContext = context;
    for (const preExecParm of node.preExecQueries) {
        currentContext = currentContext.addPreExecuteQuery(preExecParm.query, preExecParm.resultVariable, preExecParm.resultValidator);
    }

    return aql`${processNode(node.resultNode, currentContext)}`;
});

register(EntityFromIdQueryNode, (node, context) => {
    const collection = getCollectionForType(node.rootEntityType, AccessType.READ, context);
    return aql`DOCUMENT(${collection}, ${processNode(node.idNode, context)})`;
});


register(FieldQueryNode, (node, context) => {
    const object = processNode(node.objectNode, context);
    return aql`${object}${getFieldPathAccessFragment(node.path)}${getFieldAccessFragment(node.field)}`;
    // @MSF TODO: create new Node FieldPathQueryNode instead of FieldQueryNode
});

function getFieldAccessFragment(field: Field) {
    let identifier = field.name;
    if (aql.isSafeIdentifier(identifier)) {
        return aql`.${aql.identifier(identifier)}`;
    }
    // fall back to bound values. do not attempt aql.string for security reasons - should not be the case normally, anyway.
    return aql`[${identifier}]`;
}

function getFieldPathAccessFragment(path?: Field[]): AQLFragment {
    if (path && path.length > 0) {
        return aql`.${aql.identifier(path[0].name)}${getFieldPathAccessFragment(path.slice(1))}`;
    } else {
        return aql``;
    }

}

register(RootEntityIDQueryNode, (node, context) => {
    return aql`${processNode(node.objectNode, context)}._key`; // ids are stored in _key field
});

register(QuickSearchQueryNode, (node, context) => {
    // @MSF TODO: Authentification
    //
    let itemContext = context.introduceVariable(node.itemVariable);
    return aql`(FOR ${itemContext.getVariable(node.itemVariable)} IN ${aql.identifier(getViewNameForRootEntity(node.rootEntityType!))} SEARCH ${processNode(node.qsFilterNode, itemContext)} RETURN ${itemContext.getVariable(node.itemVariable)})`;
});

// @MSF TODO: create AQL like this:
// return aqlExt.parenthesizeList(
//     aql`FOR ${itemVar}`,
//     aql`IN ${list}`,
//     (filter instanceof ConstBoolQueryNode && filter.value) ? aql`` : aql`FILTER ${processNode(filter, itemContext)}`,
//     filterDanglingEdges,
//     generateSortAQL(node.orderBy, itemContext),
//     limitClause,
//     useIndirectedProjection ? aql`LET ${itemProjectionVar} = DOCUMENT(${itemVar}._id)` : aql``,
//     ...variableAssignments,
//     aql`RETURN ${processNode(innerNode, itemProjectionContext)}`
// );


register(TransformListQueryNode, (node, context) => {
    let itemContext = context.introduceVariable(node.itemVariable);
    const itemVar = itemContext.getVariable(node.itemVariable);

    // in certain conditions, it greatly reduces memory consumption if the projection part is
    // indirected via a DOCUMENT() call, see https://github.com/arangodb/arangodb/issues/7821
    const useIndirectedProjection = aqlConfig.optimizationConfig.enableExperimentalProjectionIndirection
        && node.listNode instanceof EntitiesQueryNode
        && (!aqlConfig.optimizationConfig.experimentalProjectionIndirectionTypeNames
            || aqlConfig.optimizationConfig.experimentalProjectionIndirectionTypeNames.includes(node.listNode.rootEntityType.name))
        && node.innerNode !== node.itemVariable
        && node.maxCount !== undefined;
    let itemProjectionContext = itemContext;
    let itemProjectionVar = itemVar;
    if (useIndirectedProjection) {
        itemProjectionContext = context.introduceVariable(node.itemVariable);
        itemProjectionVar = itemProjectionContext.getVariable(node.itemVariable);
    }

    let list: AQLFragment;
    let filterDanglingEdges = aql``;
    if (node.listNode instanceof FollowEdgeQueryNode) {
        list = getSimpleFollowEdgeFragment(node.listNode, context);
        filterDanglingEdges = aql`FILTER ${itemVar} != null`;
    } else {
        list = processNode(node.listNode, context);
    }
    let filter = simplifyBooleans(node.filterNode);

    let limitClause;
    if (node.maxCount != undefined) {
        if (node.skip === 0) {
            limitClause = aql`LIMIT ${node.maxCount}`;
        } else {
            limitClause = aql`LIMIT ${node.skip}, ${node.maxCount}`;
        }
    } else if (node.skip > 0) {
        limitClause = aql`LIMIT ${node.skip}, ${Number.MAX_SAFE_INTEGER}`;
    } else {
        limitClause = aql``;
    }

    // move LET statements up
    // they often occur for value objects / entity extensions
    // this avoids the FIRST() and the subquery which reduces load on the AQL query optimizer
    let variableAssignments: AQLFragment[] = [];
    let innerNode = node.innerNode;
    const variableAssignmentNodes: VariableAssignmentQueryNode[] = [];
    innerNode = extractVariableAssignments(innerNode, variableAssignmentNodes);
    for (const assignmentNode of variableAssignmentNodes) {
        itemProjectionContext = itemProjectionContext.introduceVariable(assignmentNode.variableNode);
        const tmpVar = itemProjectionContext.getVariable(assignmentNode.variableNode);
        variableAssignments.push(aql`LET ${tmpVar} = ${processNode(assignmentNode.variableValueNode, itemProjectionContext)}`);
    }

    return aqlExt.parenthesizeList(
        aql`FOR ${itemVar}`,
        aql`IN ${list}`,
        (filter instanceof ConstBoolQueryNode && filter.value) ? aql`` : aql`FILTER ${processNode(filter, itemContext)}`,
        filterDanglingEdges,
        generateSortAQL(node.orderBy, itemContext),
        limitClause,
        useIndirectedProjection ? aql`LET ${itemProjectionVar} = DOCUMENT(${itemVar}._id)` : aql``,
        ...variableAssignments,
        aql`RETURN ${processNode(innerNode, itemProjectionContext)}`
    );
});

register(CountQueryNode, (node, context) => {
    if (node.listNode instanceof FieldQueryNode || node.listNode instanceof EntitiesQueryNode) {
        // These cases are known to be optimized
        // TODO this does not catch the safe-list case (list ? list : []), where we could optimize to (list ? LENGTH(list) : 0)
        // so we probably need to add an optimization to the query tree builder
        return aql`LENGTH(${processNode(node.listNode, context)})`;
    }

    // in the general case (mostly a TransformListQueryNode), it is better to use the COLLeCT WITH COUNT syntax
    // because it avoids building the whole collection temporarily in memory
    // however, https://docs.arangodb.com/3.2/AQL/Examples/Counting.html does not really mention this case, so we
    // should evaluate it again
    // note that ArangoDB's inline-subqueries rule optimizes for the case where listNode is a TransformList again.
    const itemVar = aql.variable('item');
    const countVar = aql.variable('count');
    return aqlExt.parenthesizeObject(
        aql`FOR ${itemVar}`,
        aql`IN ${processNode(node.listNode, context)}`,
        aql`COLLECT WITH COUNT INTO ${countVar}`,
        aql`return ${countVar}`
    );
});

register(MergeObjectsQueryNode, (node, context) => {
    const objectList = node.objectNodes.map(node => processNode(node, context));
    const objectsFragment = aql.join(objectList, aql`, `);
    return aql`MERGE(${objectsFragment})`;
});

register(FirstOfListQueryNode, (node, context) => {
    return aql`FIRST(${processNode(node.listNode, context)})`;
});

register(BinaryOperationQueryNode, (node, context) => {
    const lhs = processNode(node.lhs, context);
    const rhs = processNode(node.rhs, context);
    const op = getAQLOperator(node.operator);
    if (op) {
        return aql`(${lhs} ${op} ${rhs})`;
    }

    switch (node.operator) {
        case BinaryOperator.CONTAINS:
            return aql`(${lhs} LIKE CONCAT("%", ${rhs}, "%"))`;
        case BinaryOperator.STARTS_WITH:
            const slowFrag = aql`(LEFT(${lhs}, LENGTH(${rhs})) == ${rhs})`;
            if (node.rhs instanceof LiteralQueryNode && typeof node.rhs.value === 'string') {
                const fastFrag = getFastStartsWithQuery(lhs, node.rhs.value);
                // still ned to use the slow frag to get case sensitiveness
                // this is really bad for performance, see explanation in LIKE branch below
                return aql`${fastFrag} && ${slowFrag}`;
            }
            return slowFrag;
        case BinaryOperator.ENDS_WITH:
            return aql`(RIGHT(${lhs}, LENGTH(${rhs})) == ${rhs})`;
        case BinaryOperator.LIKE:
            const slowLikeFrag = aql`LIKE(${lhs}, ${rhs}, true)`; // true: caseInsensitive
            if (node.rhs instanceof LiteralQueryNode && typeof node.rhs.value === 'string') {
                const { literalPrefix, isSimplePrefixPattern, isLiteralPattern } = analyzeLikePatternPrefix(node.rhs.value);

                if (isLiteralPattern) {
                    return getEqualsIgnoreCaseQuery(lhs, literalPrefix);
                }

                const fastFrag = getFastStartsWithQuery(lhs, literalPrefix);
                if (isSimplePrefixPattern) {
                    // we can optimize the whole LIKE away and use a skiplist-index-optimizable range select
                    return fastFrag;
                }
                // we can at least use the prefix search to narrow down the results
                // however, this is way worse because we lose the ability to sort-and-then-limit using the same index
                // -> queries with a "first" argument suddenly have the time complexity of the pre-limited
                // (or even pre-filtered if the database decides to use the index for sorting) result size instead of
                // being in O(first).
                return aql`(${fastFrag} && ${slowLikeFrag})`;
            }
            return slowLikeFrag;
        case BinaryOperator.APPEND:
            return aql`CONCAT(${lhs}, ${rhs})`;
        case BinaryOperator.PREPEND:
            return aql`CONCAT(${rhs}, ${lhs})`;
        default:
            throw new Error(`Unsupported binary operator: ${op}`);
    }

});

register(OperatorWithLanguageQueryNode, (node, context) => {

    const lhs = processNode(node.lhs, context);
    const rhs = processNode(node.rhs, context);
    const analyzer = node.quickSearchLanguage ? `text_${node.quickSearchLanguage.toLowerCase()}` : IDENTITY_ANALYZER

    switch (node.operator) {
        case BinaryOperatorWithLanguage.QUICKSEARCH_STARTS_WITH:
            return aql`STARTS_WITH(${lhs},${rhs})`;
        case BinaryOperatorWithLanguage.QUICKSEARCH_CONTAINS_ANY_WORD:
            return aql`ANALYZER( ${lhs} IN TOKENS(${rhs}, ${analyzer}),${analyzer})`;
        case BinaryOperatorWithLanguage.QUICKSEARCH_CONTAINS_PREFIX:
            return aql`ANALYZER( STARTS_WITH( ${lhs}, TOKENS(${rhs})[0]), ${analyzer}))`;
        case BinaryOperatorWithLanguage.QUICKSEARCH_CONTAINS_PHRASE:
            return aql`ANALYZER( PHRASE( ${lhs}, ${rhs}), ${analyzer})`;
        default:
            throw new Error(`Unsupported ternary operator: ${node.operator}`);
    }

});


function getFastStartsWithQuery(lhs: AQLFragment, rhsValue: string): AQLFragment {
    if (!rhsValue.length) {
        return aql`IS_STRING(${lhs})`;
    }

    // this works as long as the highest possible code point is also the last one in the collation
    const maxChar = String.fromCodePoint(0x10FFFF);
    const maxStr = rhsValue + maxChar;

    // UPPER is used to get the "smallest" representation of the value case-sensitive, LOWER for the "largest".
    // the ordering looks like this:
    // [
    //   "A",
    //   "a",
    //   "AA",
    //   "Aa",
    //   "aA",
    //   "aa",
    //   "AB",
    //   "Ab",
    //   "aB",
    //   "ab",
    //   "B",
    //   "b"
    // ]
    // This means that if the actual value is longer than the given prefix (i.e. it's a real prefix and not the whole
    // string), the match will be case-insensitive. However, if the remaining suffix if empty, the search would
    // sometimes be case-sensitive: If you search for the prefix a, A will not be found (because A < a), but a will
    // match the prefix filter A. In order to avoid this, one needs to convert the given string to the lowest value
    // within its case-sensitivity category. For ASCII characters, that's simply UPPER(), but that will not always be
    // the case. The same thing applies to the upper bound.
    return aql`(${lhs} >= UPPER(${rhsValue}) && ${lhs} < LOWER(${maxStr}))`;

    // the following does not work because string sorting depends on the DB's collator
    // which does not necessarily sort the characters by code points
    // charCodeAt / fromCharCode works on code units, and so does the string indexer / substr / length
    /*const lastCharCode = rhsValue.charCodeAt(rhsValue.length - 1);
    const nextCharCode = lastCharCode + 1;
    if (nextCharCode >= 0xD800) {
        // don't mess with surrogate pairs
        return undefined;
    }

    const nextValue = rhsValue.substring(0, rhsValue.length - 1) + String.fromCharCode(nextCharCode);
    return aql`(${lhs} >= ${rhsValue} && ${lhs} < ${nextValue})`;*/
}

function getEqualsIgnoreCaseQuery(lhs: AQLFragment, rhsValue: string): AQLFragment {
    // if the string e.g. only consists of digits, no need for special case sensitivity checking
    if (isStringCaseInsensitive(rhsValue)) {
        return aql`(${lhs} == ${aql.value(rhsValue)})`;
    }

    // w.r.t. UPPER/LOWER, see the comment in getFastStartsWithQuery
    const lowerBoundFrag = aql`UPPER(${rhsValue})`;
    const upperBoundFrag = aql`LOWER(${rhsValue})`;
    return aql`(${lhs} >= ${lowerBoundFrag} && ${lhs} <= ${upperBoundFrag})`;
}

register(UnaryOperationQueryNode, (node, context) => {
    switch (node.operator) {
        case UnaryOperator.NOT:
            return aql`!(${processNode(node.valueNode, context)})`;
        case UnaryOperator.JSON_STRINGIFY:
            return aql`JSON_STRINGIFY(${processNode(node.valueNode, context)})`;
        default:
            throw new Error(`Unsupported unary operator: ${node.operator}`);
    }
});

register(ConditionalQueryNode, (node, context) => {
    const cond = processNode(node.condition, context);
    const expr1 = processNode(node.expr1, context);
    const expr2 = processNode(node.expr2, context);
    return aql`(${cond} ? ${expr1} : ${expr2})`;
});

register(TypeCheckQueryNode, (node, context) => {
    const value = processNode(node.valueNode, context);

    switch (node.type) {
        case BasicType.SCALAR:
            return aql`(IS_BOOL(${value}) || IS_NUMBER(${value}) || IS_STRING(${value}))`;
        case BasicType.LIST:
            return aql`IS_LIST(${value})`;
        case BasicType.OBJECT:
            return aql`IS_OBJECT(${value})`;
        case BasicType.NULL:
            return aql`IS_NULL(${value})`;
    }
});

register(SafeListQueryNode, (node, context) => {
    const reducedNode = new ConditionalQueryNode(new TypeCheckQueryNode(node.sourceNode, BasicType.LIST), node.sourceNode, ListQueryNode.EMPTY);
    return processNode(reducedNode, context);
});

register(QuantifierFilterNode, (node, context) => {
    let { quantifier, conditionNode, listNode, itemVariable } = node;
    conditionNode = simplifyBooleans(conditionNode);

    const fastFragment = getQuantifierFilterUsingArrayExpansion({ quantifier, conditionNode, listNode, itemVariable }, context);
    if (fastFragment) {
        return fastFragment;
    }

    // reduce 'every' to 'none' so that count-based evaluation is possible
    if (quantifier === 'every') {
        quantifier = 'none';
        conditionNode = not(conditionNode);
    }

    const filteredListNode = new TransformListQueryNode({
        listNode,
        filterNode: conditionNode,
        itemVariable
    });

    const finalNode = new BinaryOperationQueryNode(new CountQueryNode(filteredListNode),
        quantifier === 'none' ? BinaryOperator.EQUAL : BinaryOperator.GREATER_THAN, new LiteralQueryNode(0));
    return processNode(finalNode, context);
});

// uses the array expansion operator (https://docs.arangodb.com/3.0/AQL/Advanced/ArrayOperators.html#array-expansion)
// that can utilize an index like "items[*].itemNumber" if possible
// (specifically for something like items_some: {itemNumber: "abc"})
function getQuantifierFilterUsingArrayExpansion(
    { quantifier, conditionNode, listNode, itemVariable }: {
        quantifier: Quantifier, conditionNode: QueryNode, listNode: QueryNode, itemVariable: VariableQueryNode
    },
    context: QueryContext
): AQLFragment | undefined {
    if (quantifier !== 'some') {
        return undefined;
    }

    // only possible on lists that are field accesses,
    // but "safe lists" are ok because the IN operator implicitly ignores NULL values
    if (listNode instanceof SafeListQueryNode) {
        listNode = listNode.sourceNode;
    }
    if (!(listNode instanceof FieldQueryNode)) {
        return undefined;
    }

    if (!(conditionNode instanceof BinaryOperationQueryNode)) {
        return undefined;
    }

    switch (conditionNode.operator) {
        case BinaryOperator.EQUAL:
            // works
            break;
        case BinaryOperator.LIKE:
            // see if this really is a equals search so we can optimize it (only possible as long as it does not contain any case-specific characters)
            if (!(conditionNode.rhs instanceof LiteralQueryNode) || (typeof conditionNode.rhs.value !== 'string')) {
                return undefined;
            }
            const likePattern: string = conditionNode.rhs.value;
            const { isLiteralPattern } = analyzeLikePatternPrefix(likePattern);
            if (!isLiteralPattern || !isStringCaseInsensitive(likePattern)) {
                return undefined;
            }
            // works
            break;
        default:
            return undefined;
    }

    let fields: Field[] = [];
    let currentFieldNode = conditionNode.lhs;
    do {
        if (!(currentFieldNode instanceof FieldQueryNode)) {
            return undefined;
        }
        fields.unshift(currentFieldNode.field); // we're traversing from back to front
        currentFieldNode = currentFieldNode.objectNode;
    } while (currentFieldNode !== itemVariable);

    const valueFrag = processNode(conditionNode.rhs, context);
    const fieldAccessFrag = aql.concat(fields.map(f => getFieldAccessFragment(f)));
    return aql`${valueFrag} IN ${processNode(listNode, context)}[*]${fieldAccessFrag}`;
}

register(EntitiesQueryNode, (node, context) => {
    return getCollectionForType(node.rootEntityType, AccessType.READ, context);
});

register(FollowEdgeQueryNode, (node, context) => {
    const tmpVar = aql.variable('node');
    // need to wrap this in a subquery because ANY is not possible as first token of an expression node in AQL
    return aqlExt.parenthesizeList(
        aql`FOR ${tmpVar}`,
        aql`IN ${getSimpleFollowEdgeFragment(node, context)}`,
        aql`FILTER ${tmpVar} != null`,
        aql`RETURN ${tmpVar}`
    );
});

register(CreateEntityQueryNode, (node, context) => {
    return aqlExt.parenthesizeObject(
        aql`INSERT ${processNode(node.objectNode, context)} IN ${getCollectionForType(node.rootEntityType, AccessType.WRITE, context)}`,
        aql`RETURN NEW._key`
    );
});

register(UpdateEntitiesQueryNode, (node, context) => {
    const newContext = context.introduceVariable(node.currentEntityVariable);
    const entityVar = newContext.getVariable(node.currentEntityVariable);
    return aqlExt.parenthesizeList(
        aql`FOR ${entityVar}`,
        aql`IN ${processNode(node.listNode, context)}`,
        aql`UPDATE ${entityVar}`,
        aql`WITH ${processNode(new ObjectQueryNode(node.updates), newContext)}`,
        aql`IN ${getCollectionForType(node.rootEntityType, AccessType.WRITE, context)}`,
        aql`OPTIONS { mergeObjects: false }`,
        aql`RETURN NEW._key`
    );
});

register(DeleteEntitiesQueryNode, (node, context) => {
    const entityVar = aql.variable(decapitalize(node.rootEntityType.name));
    return aqlExt.parenthesizeList(
        aql`FOR ${entityVar}`,
        aql`IN ${processNode(node.listNode, context)}`,
        aql`REMOVE ${entityVar}`,
        aql`IN ${getCollectionForType(node.rootEntityType, AccessType.WRITE, context)}`,
        aql`RETURN OLD`
    );
});

register(AddEdgesQueryNode, (node, context) => {
    const edgeVar = aql.variable('edge');
    return aqlExt.parenthesizeList(
        aql`FOR ${edgeVar}`,
        aql`IN [ ${aql.join(node.edges.map(edge => formatEdge(node.relation, edge, context)), aql`, `)} ]`,
        aql`UPSERT { _from: ${edgeVar}._from, _to: ${edgeVar}._to }`, // need to unpack avoid dynamic property names in UPSERT example filter
        aql`INSERT ${edgeVar}`,
        aql`UPDATE {}`,
        aql`IN ${getCollectionForRelation(node.relation, AccessType.WRITE, context)}`
    );
});

register(RemoveEdgesQueryNode, (node, context) => {
    const edgeVar = aql.variable('edge');
    const fromVar = aql.variable('from');
    const toVar = aql.variable('to');
    let edgeFilter: AQLFragment;
    if (node.edgeFilter.fromIDsNode && node.edgeFilter.toIDsNode) {
        edgeFilter = aql`FILTER ${edgeVar}._from == ${fromVar} && ${edgeVar}._to == ${toVar}`;
    } else if (node.edgeFilter.fromIDsNode) {
        edgeFilter = aql`FILTER ${edgeVar}._from == ${fromVar}`;
    } else if (node.edgeFilter.toIDsNode) {
        edgeFilter = aql`FILTER ${edgeVar}._to == ${toVar}`;
    } else {
        edgeFilter = aql``;
    }
    return aqlExt.parenthesizeList(
        node.edgeFilter.fromIDsNode ? aql`FOR ${fromVar} IN ${getFullIDsFromKeysNode(node.edgeFilter.fromIDsNode!, node.relation.fromType, context)}` : aql``,
        node.edgeFilter.toIDsNode ? aql`FOR ${toVar} IN ${getFullIDsFromKeysNode(node.edgeFilter.toIDsNode!, node.relation.toType, context)}` : aql``,
        aql`FOR ${edgeVar} IN ${getCollectionForRelation(node.relation, AccessType.READ, context)}`,
        edgeFilter,
        aql`REMOVE ${edgeVar} IN ${getCollectionForRelation(node.relation, AccessType.WRITE, context)}`
    );
});

register(SetEdgeQueryNode, (node, context) => {
    const edgeVar = aql.variable('edge');
    return aqlExt.parenthesizeList(
        aql`UPSERT ${formatEdge(node.relation, node.existingEdge, context)}`,
        aql`INSERT ${formatEdge(node.relation, node.newEdge, context)}`,
        aql`UPDATE ${formatEdge(node.relation, node.newEdge, context)}`,
        aql`IN ${getCollectionForRelation(node.relation, AccessType.WRITE, context)}`
    );
});

/**
 * Gets an aql fragment that evaluates to a string of the format "collectionName/objectKey", given a query node that
 * evaluates to the "object id", which is, in arango terms, the _key.
 */
function getFullIDFromKeyNode(node: QueryNode, rootEntityType: RootEntityType, context: QueryContext): AQLFragment {
    // special handling to avoid concat if possible - do not alter the behavior
    if (node instanceof LiteralQueryNode && typeof node.value == 'string') {
        // just append the node to the literal key in JavaScript and bind it as a string
        return aql`${getCollectionNameForRootEntity(rootEntityType) + '/' + node.value}`;
    }
    if (node instanceof RootEntityIDQueryNode) {
        // access the _id field. processNode(node) would access the _key field instead.
        return aql`${processNode(node.objectNode, context)}._id`;
    }

    // fall back to general case
    return getFullIDFromKeyFragment(processNode(node, context), rootEntityType);
}

function getFullIDsFromKeysNode(idsNode: QueryNode, rootEntityType: RootEntityType, context: QueryContext): AQLFragment {
    if (idsNode instanceof ListQueryNode) {
        // this probably generates cleaner AQL without dynamic concat
        const idFragments = idsNode.itemNodes.map(idNode => getFullIDFromKeyNode(idNode, rootEntityType, context));
        return aql`[${aql.join(idFragments, aql`, `)}]`;
    }
    if (idsNode instanceof LiteralQueryNode && Array.isArray(idsNode.value) && idsNode.value.every(v => typeof v === 'string')) {
        const collName = getCollectionNameForRootEntity(rootEntityType);
        const ids = idsNode.value.map(val => collName + '/' + val);
        return aql.value(ids);
    }

    const idVar = aql.variable('id');
    return aql`(FOR ${idVar} IN ${processNode(idsNode, context)} RETURN ${getFullIDFromKeyFragment(idVar, rootEntityType)})`;
}

function getFullIDFromKeyFragment(keyFragment: AQLFragment, rootEntityType: RootEntityType): AQLFragment {
    return aql`CONCAT(${getCollectionNameForRootEntity(rootEntityType) + '/'}, ${keyFragment})`;
}

function formatEdge(relation: Relation, edge: PartialEdgeIdentifier | EdgeIdentifier, context: QueryContext): AQLFragment {
    const conditions = [];
    if (edge.fromIDNode) {
        conditions.push(aql`_from: ${getFullIDFromKeyNode(edge.fromIDNode, relation.fromType, context)}`);
    }
    if (edge.toIDNode) {
        conditions.push(aql`_to: ${getFullIDFromKeyNode(edge.toIDNode, relation.toType, context)}`);
    }

    return aql`{${aql.join(conditions, aql`, `)}}`;
}

function getAQLOperator(op: BinaryOperator): AQLFragment | undefined {
    switch (op) {
        case BinaryOperator.AND:
            return aql`&&`;
        case BinaryOperator.OR:
            return aql`||`;
        case BinaryOperator.EQUAL:
            return aql`==`;
        case BinaryOperator.UNEQUAL:
            return aql`!=`;
        case BinaryOperator.LESS_THAN:
            return aql`<`;
        case BinaryOperator.LESS_THAN_OR_EQUAL:
            return aql`<=`;
        case BinaryOperator.GREATER_THAN:
            return aql`>`;
        case BinaryOperator.GREATER_THAN_OR_EQUAL:
            return aql`>=`;
        case BinaryOperator.IN:
            return aql`IN`;
        case BinaryOperator.ADD:
            return aql`+`;
        case BinaryOperator.SUBTRACT:
            return aql`-`;
        case BinaryOperator.MULTIPLY:
            return aql`*`;
        case BinaryOperator.DIVIDE:
            return aql`/`;
        case BinaryOperator.MODULO:
            return aql`%`;
        default:
            return undefined;
    }
}

function generateSortAQL(orderBy: OrderSpecification, context: QueryContext): AQLFragment {
    if (orderBy.isUnordered()) {
        return aql``;
    }

    function dirAQL(dir: OrderDirection) {
        if (dir == OrderDirection.DESCENDING) {
            return aql` DESC`;
        }
        return aql``;
    }

    const clauses = orderBy.clauses.map(cl => aql`(${processNode(cl.valueNode, context)}) ${dirAQL(cl.direction)}`);

    return aql`SORT ${aql.join(clauses, aql`, `)}`;
}

function processNode(node: QueryNode, context: QueryContext): AQLFragment {
    const processor = processors.get(node.constructor as Constructor<QueryNode>);
    if (!processor) {
        throw new Error(`Unsupported query type: ${node.constructor}`);
    }
    return processor(node, context);
}

// TODO I think AQLCompoundQuery (AQL transaction node) should not be the exported type
// we should rather export AQLExecutableQuery[] (as AQL transaction) directly.
export function getAQLQuery(node: QueryNode): AQLCompoundQuery {
    return createAQLCompoundQuery(node, aql.queryResultVariable('result'), undefined, new QueryContext());
}

function getCollectionForType(type: RootEntityType, accessType: AccessType, context: QueryContext) {
    const name = getCollectionNameForRootEntity(type);
    context.addCollectionAccess(name, accessType);
    return aql.collection(name);
}

function getCollectionForRelation(relation: Relation, accessType: AccessType, context: QueryContext) {
    const name = getCollectionNameForRelation(relation);
    context.addCollectionAccess(name, accessType);
    return aql.collection(name);
}

/**
 * Processes a FollowEdgeQueryNode into a fragment to be used within `IN ...` (as opposed to be used in a general
 * expression context)
 */
function getSimpleFollowEdgeFragment(node: FollowEdgeQueryNode, context: QueryContext): AQLFragment {
    const dir = node.relationSide.isFromSide ? aql`OUTBOUND` : aql`INBOUND`;
    return aql`${dir}  ${processNode(node.sourceEntityNode, context)} ${getCollectionForRelation(node.relationSide.relation, AccessType.READ, context)}`;
}

function isStringCaseInsensitive(str: string) {
    return str.toLowerCase() === str.toUpperCase();
}
