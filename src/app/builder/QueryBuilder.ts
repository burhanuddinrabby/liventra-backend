import { Query } from 'mongoose';

class QueryBuilder<T> {
    public modelQuery: Query<T[], T>;
    public query: Record<string, unknown>;

    constructor(modelQuery: Query<T[], T>, query: Record<string, unknown>) {
        this.modelQuery = modelQuery;
        this.query = query;
    }

    search(searchFields: string[]) {
        const searchTerm = this?.query?.searchTerm as string;
        if (searchTerm) {
            this.modelQuery = this.modelQuery.find({
                $or: searchFields.map(
                    (field) =>
                    ({
                        [field]: { $regex: searchTerm, $options: 'i' }
                    })
                )
            })
        }
        return this;
    };

    filter() {
        const queryObject = { ...this?.query };
        const excludeFields = ['searchTerm', 'sort', 'limit', 'page', 'fields'];
        excludeFields.forEach(el => delete queryObject[el]);
        this.modelQuery = this.modelQuery.find(queryObject);//exact match based on query
        return this;
    }

    sort() {
        const sort = (this?.query?.sort as string)?.split(',').join(' ') || '-createdAt';
        this.modelQuery = this.modelQuery.sort(sort as string);
        return this;
    };

    paginate() {
        const page = Number(this?.query?.page) || 1;
        const limit = Number(this?.query?.limit) || 10;
        const skip = (page - 1) * limit;
        this.modelQuery = this.modelQuery.skip(skip).limit(limit);

        return this;
    }

    fields() {
        const limitedFields = (this?.query?.fields as string)?.split(',').join(' ') || '-__v';
        this.modelQuery = this.modelQuery.select(limitedFields)

        return this;
    }

    async countTotal() {
        const filter = this.modelQuery.getFilter();
        const total = await this.modelQuery.model.countDocuments(filter);
        const page = Number(this?.query?.page) || 1;
        const limit = Number(this?.query?.limit) || 10;
        const totalPage = Math.ceil(total / limit);
        return {
            page,
            limit,
            totalEntries: total,
            totalPage
        }
    }
}

export default QueryBuilder;